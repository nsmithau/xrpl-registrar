import { PGlite } from "@electric-sql/pglite";

import type { Database, Queryable, QueryResult, Row } from "./database.js";

export interface PgliteOptions {
  /**
   * Filesystem directory for the embedded database. Omit for an ephemeral
   * in-memory database (used by tests). A persistent archive must set this.
   */
  readonly dataDir?: string;
}

/** In-process Postgres backed by PGlite — no separate server or container. */
export class PgliteDatabase implements Database {
  readonly #pg: PGlite;

  private constructor(pg: PGlite) {
    this.#pg = pg;
  }

  static async open(options: PgliteOptions = {}): Promise<PgliteDatabase> {
    // `create(undefined)` yields an in-memory database.
    const pg = await PGlite.create(options.dataDir);
    return new PgliteDatabase(pg);
  }

  async query<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const res = await this.#pg.query<T>(sql, params);
    return { rows: res.rows, affectedRows: res.affectedRows ?? 0 };
  }

  async exec(sql: string): Promise<void> {
    await this.#pg.exec(sql);
  }

  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    const result = await this.#pg.transaction(async (tx) => {
      const queryable: Queryable = {
        query: async <U extends Row = Row>(sql: string, params: unknown[] = []) => {
          const res = await tx.query<U>(sql, params);
          return { rows: res.rows, affectedRows: res.affectedRows ?? 0 };
        },
        exec: async (sql: string) => {
          await tx.exec(sql);
        },
      };
      return fn(queryable);
    });
    return result as T;
  }

  async close(): Promise<void> {
    await this.#pg.close();
  }
}
