/**
 * Storage abstraction.
 *
 * Repositories depend only on these interfaces, never on a concrete driver.
 * Two engines satisfy it: in-process PGlite (the default) and networked
 * Postgres (`pg`). Callers that must branch — today, post-delete compaction —
 * read `engine` rather than sniffing at the driver.
 */

export type Row = Record<string, unknown>;

export interface QueryResult<T extends Row = Row> {
  readonly rows: T[];
  readonly affectedRows: number;
}

/** The subset available both on a connection and inside a transaction. */
export interface Queryable {
  /** Parameterised query using Postgres `$1, $2, …` placeholders. */
  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  /** Execute one or more statements with no parameters (DDL, migrations). */
  exec(sql: string): Promise<void>;
}

export interface Database extends Queryable {
  /** Which engine backs this handle. */
  readonly engine: "pglite" | "postgres";
  /** Run `fn` inside a transaction; commit on resolve, roll back on throw. */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  /**
   * Run `fn` holding an exclusive lock that excludes *other processes* opening
   * the same archive, used to serialise schema migration.
   *
   * Optional, because it is only meaningful for an engine several processes
   * can attach to at once. The in-process engine omits it — a PGlite database
   * has exactly one writer by construction — and callers must therefore treat
   * its absence as "no lock needed" rather than as an error.
   */
  withMigrationLock?<T>(fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
