/**
 * Opening a database in tests, against whichever engine is being exercised.
 *
 * `pnpm test` runs everything on in-process PGlite: offline, no container, the
 * default developer loop. `pnpm test:pg` sets `TEST_DATABASE_URL` and the very
 * same suites run against a real Postgres server. That is the point of routing
 * every suite through here rather than calling `openArchiveDatabase` directly
 * — the two engines are only meaningfully equivalent if the same assertions
 * run against both.
 *
 * On Postgres each call gets its own schema, created up front and dropped when
 * the database is closed, so suites running concurrently in separate vitest
 * workers cannot see each other's tables despite sharing one database.
 */
import pg from "pg";

import { openArchiveDatabase, PostgresDatabase, type Database } from "../src/db/index.js";
import { nullLogger } from "../src/logging/logger.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL?.trim() || undefined;

/** True when the suite is running against a real Postgres server. */
export const usingPostgres = TEST_DATABASE_URL !== undefined;

// Tests that are only meaningful against a real server — concurrency, driver
// type mapping, cross-process locking — guard with `describe.skipIf(!usingPostgres)`
// so they skip silently on PGlite rather than fail, keeping the offline loop green.

// Schemas must not collide across vitest workers, which are separate
// processes, nor across calls within one file.
let schemaCounter = 0;
function nextSchemaName(): string {
  schemaCounter += 1;
  return `test_${process.pid}_${schemaCounter}`;
}

async function withAdminClient(fn: (c: pg.Client) => Promise<void>): Promise<void> {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  try {
    await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * Delegate to the real driver, dropping the schema after close.
 *
 * Explicit bound methods rather than a Proxy or prototype trickery: the driver
 * keeps its state in `#private` fields, which a Proxy cannot forward — that
 * fails at runtime with "Cannot read private member", not at compile time.
 */
function droppingSchemaOnClose(db: Database, schema: string): Database {
  return {
    engine: db.engine,
    query: db.query.bind(db),
    exec: db.exec.bind(db),
    transaction: db.transaction.bind(db),
    ...(db.withMigrationLock
      ? { withMigrationLock: <T>(fn: () => Promise<T>) => db.withMigrationLock!(fn) }
      : {}),
    close: async () => {
      await db.close();
      await withAdminClient(async (c) => {
        await c.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      });
    },
  };
}

/** Pools are per-database-instance and suites run in parallel, so keep each
 * one small — the server's connection limit is shared by every worker. */
const TEST_POOL_MAX = 4;

async function openPostgresTestDatabase(migrate: boolean): Promise<Database> {
  const schema = nextSchemaName();
  await withAdminClient(async (c) => {
    await c.query(`CREATE SCHEMA "${schema}"`);
  });
  const options = {
    engine: "postgres" as const,
    connectionString: TEST_DATABASE_URL!,
    schema,
    max: TEST_POOL_MAX,
    logger: nullLogger,
  };
  const db = migrate ? await openArchiveDatabase(options) : PostgresDatabase.open(options);
  return droppingSchemaOnClose(db, schema);
}

/**
 * An empty archive at the latest schema — the drop-in replacement for
 * `openArchiveDatabase()` in tests. Close it to release the database; on
 * Postgres that also drops the schema.
 */
export async function openTestDatabase(): Promise<Database> {
  return usingPostgres ? openPostgresTestDatabase(true) : openArchiveDatabase();
}

/**
 * A database with *no* migrations applied, for tests that exercise the
 * migration runner itself and need to observe it doing the work.
 */
export async function openUnmigratedTestDatabase(): Promise<Database> {
  if (usingPostgres) return openPostgresTestDatabase(false);
  const { PgliteDatabase } = await import("../src/db/pglite.js");
  return PgliteDatabase.open();
}

/**
 * A second handle on the *same* underlying storage, for tests that need two
 * independent connections (concurrency, cross-process locking). On PGlite
 * there is no such thing — an in-memory database is private to its handle — so
 * this is only available under Postgres.
 */
export async function openSecondHandle(db: Database): Promise<Database> {
  if (!usingPostgres) throw new Error("openSecondHandle requires TEST_DATABASE_URL");
  const { rows } = await db.query<{ schema: string }>("SELECT current_schema() AS schema");
  const schema = rows[0]!.schema;
  // Deliberately not wrapped in droppingSchemaOnClose: the first handle owns
  // the schema's lifetime, and dropping it here would pull the floor out from
  // under a still-open database.
  return PostgresDatabase.open({
    connectionString: TEST_DATABASE_URL!,
    schema,
    max: TEST_POOL_MAX,
    logger: nullLogger,
  });
}
