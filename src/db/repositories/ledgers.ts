import type { Database, Queryable } from "../database.js";

export interface LedgerTime {
  readonly ledgerIndex: number;
  readonly closeTimeIso: string;
}

/** Records ledger close times and resolves timestamps to a ledger index. */
export class LedgerTimeRepository {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /** Record a ledger's close time using the given queryable. Immutable per
   * ledger, so conflicts are ignored. */
  static async recordInto(q: Queryable, entry: LedgerTime): Promise<void> {
    await q.query(
      `INSERT INTO ledgers (ledger_index, close_time_iso)
       VALUES ($1, $2) ON CONFLICT (ledger_index) DO NOTHING`,
      [entry.ledgerIndex, entry.closeTimeIso],
    );
  }

  async record(entry: LedgerTime): Promise<void> {
    await LedgerTimeRepository.recordInto(this.#db, entry);
  }

  async recordMany(entries: readonly LedgerTime[]): Promise<void> {
    if (entries.length === 0) return;
    await this.#db.transaction(async (tx) => {
      for (const e of entries) await LedgerTimeRepository.recordInto(tx, e);
    });
  }

  /**
   * The ledger in effect at or before a timestamp: the highest ledger index
   * whose close time is `<= iso`. Null if none is that old in the archive.
   */
  async resolveAtOrBefore(iso: string): Promise<number | null> {
    const { rows } = await this.#db.query<{ m: number | string | null }>(
      "SELECT max(ledger_index) AS m FROM ledgers WHERE close_time_iso <= $1::timestamptz",
      [iso],
    );
    const m = rows[0]?.m;
    return m === null || m === undefined ? null : Number(m);
  }

  async count(): Promise<number> {
    const { rows } = await this.#db.query<{ n: number | string }>(
      "SELECT count(*)::bigint AS n FROM ledgers",
    );
    return Number(rows[0]!.n);
  }
}
