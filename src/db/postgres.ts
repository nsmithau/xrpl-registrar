/**
 * Networked Postgres, the second engine behind the `Database` interface
 * (ADR-010). Same SQL, same schema, same repositories as the in-process PGlite
 * engine — the only implementation difference that leaks upward is concurrency,
 * and that is what most of this file is about.
 *
 * PGlite serialises every statement on one thread, so the backfill worker's
 * concurrent account loops and the gap heal's concurrent issuer sweeps
 * interleave but never truly contend. On a pool they are genuinely concurrent
 * transactions upserting overlapping rows in `accounts`, `transactions`, and
 * `balance_deltas`, so deadlocks are an expected operating condition rather
 * than a defect. They are handled on two fronts: the batch writers sort by key
 * to take row locks in a consistent order (see `insertTransactionRowsMany` and
 * `insertDeltasMany`), and `transaction()` here retries the ones that still get
 * through.
 */
import pg from "pg";

import type { Database, Queryable, QueryResult, Row } from "./database.js";

export interface PostgresOptions {
  /** Postgres connection URI, e.g. `postgres://user:pw@host:5432/archive`. */
  readonly connectionString: string;
  /**
   * Maximum pooled connections. The writers cap their own fan-out (4 concurrent
   * account backfills, 4 concurrent issuer sweeps) and the read API is light,
   * so the default leaves headroom without holding connections the server could
   * give to anything else sharing it.
   */
  readonly max?: number;
  /** Require TLS to the server. */
  readonly ssl?: boolean;
  /** Reported as `application_name`, so `pg_stat_activity` names us. */
  readonly applicationName?: string;
  /**
   * Schema to resolve unqualified names against, set as the connection's
   * `search_path`. Omit for the server default (`public`).
   *
   * Applied as a connection option rather than a `SET` statement, so it holds
   * for every connection the pool opens. A `SET` would configure one session
   * and silently not apply to the next connection handed out — which, with a
   * pool, is most of them. The schema must already exist; this selects one, it
   * does not create one. Primarily how the test suite isolates concurrent
   * suites from each other inside a single database.
   */
  readonly schema?: string;
  /**
   * How many times to retry a transaction that failed with a deadlock or
   * serialization error. See {@link PostgresDatabase.transaction} for the
   * idempotency precondition this relies on.
   */
  readonly maxTransactionRetries?: number;
}

const DEFAULT_MAX_CONNECTIONS = 10;
const DEFAULT_MAX_TRANSACTION_RETRIES = 5;

/**
 * First half of the schema-migration advisory lock key — ASCII "XRPL"
 * (0x5852504C). Identifies the lock as ours within the database-wide advisory
 * namespace. Fixed, because every process racing to migrate the same archive
 * must derive the same value or the lock excludes nobody.
 */
const MIGRATION_LOCK_KEY = 0x5852504c;

/**
 * Second half of the key: which archive within the database. Advisory locks
 * share one namespace per *database*, but an archive is a *schema* — several
 * can coexist in one database, and two of them migrating at once is not a
 * race, because they share no tables. Keying on the schema as well lets those
 * proceed in parallel while still excluding a second process migrating the
 * same one.
 *
 * A plain FNV-1a over the schema name, folded into int4. A hash collision
 * between two schema names costs a little needless serialisation and nothing
 * else, so it does not need to be cryptographic — only stable across
 * processes and versions, which is why it is computed here rather than with
 * Postgres's internal `hashtext()`.
 */
function schemaLockKey(schema: string | undefined): number {
  let hash = 0x811c9dc5;
  for (const ch of schema ?? "") {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash | 0; // signed 32-bit, which is what int4 wants
}

/** `int8` / BIGINT. */
const INT8_OID = 20;

/**
 * Postgres error codes worth retrying, both of which mean "this transaction
 * lost a race and none of its work was applied" — not "the statement was
 * wrong". Anything else propagates.
 *
 * - `40P01` deadlock_detected — two transactions took the same row locks in
 *   opposite orders and the server chose us as the victim.
 * - `40001` serialization_failure — a concurrent update invalidated our
 *   snapshot.
 */
const RETRYABLE_CODES: ReadonlySet<string> = new Set(["40P01", "40001"]);

/**
 * Parse BIGINT as a JS number rather than `pg`'s default string, so a row looks
 * the same whichever engine produced it (PGlite returns numbers natively). The
 * repositories already coerce with `Number()` on every read, so this is belt
 * and braces rather than load-bearing — but it keeps the two engines
 * byte-identical, which is what makes running the same test suite against both
 * meaningful.
 *
 * Every BIGINT in the schema is a ledger index, a generated id, or a row count,
 * all of them many orders of magnitude below 2^53. Rather than assume that
 * forever, a value that would silently lose precision is an error, in keeping
 * with the fail-closed stance elsewhere: a corrupted ledger index that still
 * looks like a number is far worse than a loud failure.
 */
function parseInt8(value: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new Error(
      `BIGINT ${value} exceeds the safe integer range and cannot be read as a number`,
    );
  }
  return n;
}

/**
 * Type parsers scoped to our pool. Deliberately not `pg.types.setTypeParser`,
 * which mutates a process-global registry — this service is the only `pg`
 * consumer today, but a library that quietly reconfigures every other pool in
 * the process is a trap for whoever embeds it next.
 */
const TYPE_OVERRIDES: pg.CustomTypesConfig = {
  getTypeParser: ((oid: number, format?: unknown) =>
    oid === INT8_OID
      ? parseInt8
      : (pg.types.getTypeParser as (o: number, f?: unknown) => unknown)(
          oid,
          format,
        )) as pg.CustomTypesConfig["getTypeParser"],
};

/**
 * Quote an identifier for interpolation into a connection option, where a bind
 * parameter is not available. Rejects rather than escapes: every caller passes
 * a schema name it chose itself, so anything exotic is a mistake worth
 * surfacing, not something to paper over.
 */
function quoteIdentifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name)) {
    throw new Error(`Not a valid unquoted SQL identifier: ${name}`);
  }
  return name;
}

function isRetryable(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && RETRYABLE_CODES.has(code);
}

/** Exponential backoff with jitter, so two transactions that deadlocked do not
 * retry in lockstep and deadlock again. */
function retryDelayMs(attempt: number): number {
  const base = Math.min(20 * 2 ** attempt, 500);
  return base / 2 + Math.random() * (base / 2);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function toResult<T extends Row>(res: pg.QueryResult): QueryResult<T> {
  return { rows: res.rows as T[], affectedRows: res.rowCount ?? 0 };
}

/** A `Queryable` view over a pooled client or the pool itself. */
function queryableOf(target: pg.Pool | pg.PoolClient): Queryable {
  return {
    query: async <T extends Row = Row>(sql: string, params: unknown[] = []) =>
      toResult<T>(await target.query(sql, params)),
    exec: async (sql: string) => {
      // No parameters, so this goes over the simple query protocol, which is
      // what allows the multi-statement DDL the migrations are written as.
      await target.query(sql);
    },
  };
}

/** Postgres over the network, via a connection pool. */
export class PostgresDatabase implements Database {
  readonly #pool: pg.Pool;
  readonly #queryable: Queryable;
  readonly #maxRetries: number;
  readonly #clientConfig: pg.ClientConfig;
  readonly #schemaLockKey: number;

  private constructor(
    pool: pg.Pool,
    clientConfig: pg.ClientConfig,
    maxRetries: number,
    schemaLockKeyValue: number,
  ) {
    this.#pool = pool;
    this.#queryable = queryableOf(pool);
    this.#maxRetries = maxRetries;
    this.#clientConfig = clientConfig;
    this.#schemaLockKey = schemaLockKeyValue;
  }

  static open(options: PostgresOptions): PostgresDatabase {
    const clientConfig: pg.ClientConfig = {
      connectionString: options.connectionString,
      types: TYPE_OVERRIDES,
      ...(options.ssl !== undefined ? { ssl: options.ssl } : {}),
      ...(options.applicationName !== undefined
        ? { application_name: options.applicationName }
        : {}),
      ...(options.schema !== undefined
        ? { options: `-c search_path=${quoteIdentifier(options.schema)}` }
        : {}),
    };
    const pool = new pg.Pool({
      ...clientConfig,
      max: options.max ?? DEFAULT_MAX_CONNECTIONS,
    });
    // A pooled connection can be dropped by the server (restart, idle timeout)
    // while sitting unused in the pool. `pg` emits that on the pool, and an
    // unhandled 'error' event would take the process down — the pool discards
    // the connection and carries on by itself, so this only needs to exist.
    pool.on("error", () => {});
    return new PostgresDatabase(
      pool,
      clientConfig,
      options.maxTransactionRetries ?? DEFAULT_MAX_TRANSACTION_RETRIES,
      schemaLockKey(options.schema),
    );
  }

  async query<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    return this.#queryable.query<T>(sql, params);
  }

  async exec(sql: string): Promise<void> {
    await this.#queryable.exec(sql);
  }

  /**
   * Run `fn` in a transaction on one pooled connection, retrying on deadlock
   * and serialization failure.
   *
   * **`fn` must be idempotent.** A retry re-runs it from the top, so it may
   * execute more than once — safe only because every write in this service is
   * keyed and conflict-handled (`ON CONFLICT DO NOTHING` / `DO UPDATE`), which
   * is the same property that makes backfill resumable after a mid-page kill.
   * A new caller that does something non-idempotent here (an unconditional
   * `INSERT`, a `tx_count = tx_count + n` outside a conflict clause) would
   * double-apply it under contention.
   */
  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      const outcome = await this.#attempt(fn);
      if (outcome.ok) return outcome.value;
      if (!isRetryable(outcome.error) || attempt >= this.#maxRetries) throw outcome.error;
      // Backs off with the connection already returned to the pool, so a
      // contended write does not also hold a slot while it waits.
      await sleep(retryDelayMs(attempt));
    }
  }

  /** One transaction attempt. Returns rather than throws so the retry loop can
   * release the connection before deciding, and back off without holding it. */
  async #attempt<T>(
    fn: (tx: Queryable) => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
    const client = await this.#pool.connect();
    let broken = false;
    try {
      await client.query("BEGIN");
      const value = await fn(queryableOf(client));
      await client.query("COMMIT");
      return { ok: true, value };
    } catch (error) {
      // Leave the connection in a clean state before returning it to the pool;
      // if even the rollback fails the connection is unusable, so it is
      // destroyed rather than handed to the next caller mid-transaction.
      try {
        await client.query("ROLLBACK");
      } catch {
        broken = true;
      }
      return { ok: false, error };
    } finally {
      client.release(broken);
    }
  }

  /**
   * Run `fn` holding a session-level advisory lock, so two processes opening
   * the same archive migrate one after the other rather than at once.
   *
   * Session-level (`pg_advisory_lock`) rather than transaction-level
   * (`pg_advisory_xact_lock`): the migration run is several transactions —
   * one per migration, plus the bootstrap of `schema_migrations` — and a
   * transaction-scoped lock would be dropped at the first commit, reopening
   * the race for every migration after the first.
   *
   * The lock is taken on a dedicated connection rather than a pooled one.
   * It is held for the whole run while `fn` itself needs pooled connections to
   * do the work, so borrowing from the pool here would deadlock outright on a
   * pool of one (`DATABASE_POOL_MAX=1`) — the holder would own the only
   * connection and `fn` could never get one. Holding the lock on a different
   * connection from the DDL is fine: it is an inter-process mutex, not a lock
   * on any row.
   *
   * Waits rather than failing fast. Two instances starting together is a
   * normal restart, not an error, and the loser should come up a moment later
   * having applied nothing — not refuse to boot.
   */
  async withMigrationLock<T>(fn: () => Promise<T>): Promise<T> {
    const client = new pg.Client(this.#clientConfig);
    await client.connect();
    try {
      await client.query("SELECT pg_advisory_lock($1, $2)", [
        MIGRATION_LOCK_KEY,
        this.#schemaLockKey,
      ]);
      return await fn();
    } finally {
      // Ending the session releases its advisory locks, so there is no
      // explicit unlock: it covers the ordinary path and the one where the
      // connection has already died, which an unlock statement would not.
      try {
        await client.end();
      } catch {
        // The lock is gone either way once the session is; nothing to recover.
      }
    }
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}
