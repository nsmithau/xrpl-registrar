/**
 * Cross-process migration safety.
 *
 * On a networked Postgres nothing stops two instances of the service starting
 * at the same moment, and `runMigrations` reads the applied set and then acts
 * on it — not atomic. As with the concurrency suite, the "it works" test is
 * paired with a control that shows the collision is real: without the control,
 * a passing lock test could simply mean the migrators never overlapped.
 *
 * Skipped unless TEST_DATABASE_URL is set — `pnpm test:pg`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../../src/db/database.js";
import { runMigrations } from "../../src/db/migrate.js";
import { openSecondHandle, openUnmigratedTestDatabase, usingPostgres } from "../dbHelpers.js";

const MIGRATORS = 5;

/**
 * The same driver with its lock capability hidden, so `runMigrations` takes
 * the unlocked path — the pre-lock behaviour, for comparison.
 *
 * Bound methods rather than a Proxy: the driver holds state in `#private`
 * fields, which a Proxy cannot forward, and the control would then "collide"
 * with a TypeError instead of a real conflict — passing for the wrong reason.
 */
function withoutLock(db: Database): Database {
  return {
    engine: db.engine,
    query: db.query.bind(db),
    exec: db.exec.bind(db),
    transaction: db.transaction.bind(db),
    close: db.close.bind(db),
  };
}

describe.skipIf(!usingPostgres)("concurrent schema migration", () => {
  let owner: Database;
  let handles: Database[];

  beforeEach(async () => {
    // One empty schema, several independent connections onto it — what two
    // service processes sharing an archive look like.
    owner = await openUnmigratedTestDatabase();
    handles = [owner];
    for (let i = 1; i < MIGRATORS; i += 1) handles.push(await openSecondHandle(owner));
  });

  afterEach(async () => {
    // The owner drops the schema, so close the extra handles first.
    for (const h of handles.slice(1)) await h.close();
    await owner.close();
  });

  // The control.
  it("collides when simultaneous migrators are not serialised", async () => {
    const results = await Promise.allSettled(handles.map((h) => runMigrations(withoutLock(h))));
    const failed = results.filter((r) => r.status === "rejected");

    expect(failed.length).toBeGreaterThan(0);
    // A catalog-level unique violation or a duplicate relation — a genuine
    // race, not leftover state: the schema was empty when this started.
    expect(String((failed[0] as PromiseRejectedResult).reason)).toMatch(
      /already exists|duplicate key/i,
    );
  });

  it("serialises simultaneous migrators so every one succeeds", async () => {
    const applied = await Promise.all(handles.map((h) => runMigrations(h)));

    // Exactly one migrator does the work; the rest find nothing pending.
    expect(applied.filter((n) => n === 3)).toHaveLength(1);
    expect(applied.filter((n) => n === 0)).toHaveLength(MIGRATORS - 1);
  });

  it("leaves the schema recorded exactly once", async () => {
    await Promise.all(handles.map((h) => runMigrations(h)));

    const { rows } = await owner.query<{ name: string }>(
      "SELECT name FROM schema_migrations ORDER BY id",
    );
    expect(rows.map((r) => r.name)).toEqual(["core_schema", "ledgers", "perf_indexes"]);

    const { rows: tables } = await owner.query<{ n: number }>(
      `SELECT count(*)::bigint AS n FROM information_schema.tables
       WHERE table_schema = current_schema()`,
    );
    // 9 core tables + ledgers + schema_migrations, each created once.
    expect(Number(tables[0]!.n)).toBe(11);
  });

  it("is still a no-op on a later run", async () => {
    await Promise.all(handles.map((h) => runMigrations(h)));
    expect(await runMigrations(owner)).toBe(0);
  });

  // Two archives in different schemas share no tables, so serialising them
  // would be needless — and in the test suite, a global bottleneck.
  it("does not serialise migrations of unrelated schemas", async () => {
    const other = await openUnmigratedTestDatabase();
    try {
      // Hold the first schema's lock for the whole of the second's migration.
      // A database-wide key would deadlock this; a schema-scoped one will not.
      let otherApplied = 0;
      await owner.withMigrationLock!(async () => {
        otherApplied = await runMigrations(other);
      });
      expect(otherApplied).toBe(3);
    } finally {
      await other.close();
    }
  });
});
