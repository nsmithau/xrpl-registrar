/**
 * Storage abstraction.
 *
 * Repositories depend only on these interfaces, never on a concrete driver.
 * Today the only implementation is in-process PGlite (real Postgres, no
 * container); a networked `pg`-backed implementation can satisfy the same
 * interface later without touching a single repository.
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
  /** Run `fn` inside a transaction; commit on resolve, roll back on throw. */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
