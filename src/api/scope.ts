import type { Database } from "../db/database.js";

import type { ArchiveScopeSummary, IssuanceSummary } from "./types.js";

export interface AccountCoverage {
  readonly fromLedger: number;
  readonly toLedger: number;
}

/** Reads that answer "is this in scope, and how complete is it?" */
export class ScopeRepository {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /** Membership: is the account in the archive at all? */
  async inScope(address: string): Promise<boolean> {
    const { rows } = await this.#db.query("SELECT 1 FROM accounts WHERE address = $1 LIMIT 1", [
      address,
    ]);
    return rows.length > 0;
  }

  /** Completeness: the guaranteed-complete ledger range for an account, or null
   * if membership is known but no coverage has been recorded yet. */
  async accountCoverage(address: string): Promise<AccountCoverage | null> {
    const { rows } = await this.#db.query<{
      lo: number | string | null;
      hi: number | string | null;
    }>("SELECT min(from_ledger) AS lo, max(to_ledger) AS hi FROM coverage WHERE address = $1", [
      address,
    ]);
    const lo = rows[0]?.lo;
    const hi = rows[0]?.hi;
    if (lo === null || lo === undefined || hi === null || hi === undefined) return null;
    return { fromLedger: Number(lo), toLedger: Number(hi) };
  }

  /** The archive's latest validated ledger: the tail's high-water if it has run,
   * else the newest ledger any archived transaction lands in. 0 when empty.
   * A real ledger to report as the "as of" point when an account has no coverage
   * row yet — never a `-1` echo. */
  async latestLedger(): Promise<number> {
    const { rows } = await this.#db.query<{ hi: number | string | null }>(
      `SELECT max(hi) AS hi FROM (
         SELECT max(ledger_index) AS hi FROM ledgers
         UNION ALL SELECT max(ledger_index) FROM transactions
       ) x`,
    );
    return rows[0]?.hi != null ? Number(rows[0]!.hi) : 0;
  }

  /** The actual ledger span of an account's archived transactions, or null if it
   * has none. Distinct from `accountCoverage` (a completeness *guarantee*): this
   * is just the extent of data held, used as an honest range when coverage is
   * not yet recorded. */
  async accountDataRange(address: string): Promise<{ lo: number; hi: number } | null> {
    const { rows } = await this.#db.query<{
      lo: number | string | null;
      hi: number | string | null;
    }>(
      `SELECT min(t.ledger_index) AS lo, max(t.ledger_index) AS hi
       FROM account_transactions at
       JOIN transactions t ON t.hash = at.hash
       WHERE at.address = $1`,
      [address],
    );
    const lo = rows[0]?.lo;
    const hi = rows[0]?.hi;
    if (lo === null || lo === undefined || hi === null || hi === undefined) return null;
    return { lo: Number(lo), hi: Number(hi) };
  }

  /** Archive scope for the filtered-archive warning `details`. */
  async summarize(): Promise<ArchiveScopeSummary> {
    const issuanceRows = await this.#db.query<{
      id: number | string;
      kind: "mpt" | "iou";
      mpt_issuance_id: string | null;
      currency: string | null;
      issuer_account: string | null;
    }>("SELECT id, kind, mpt_issuance_id, currency, issuer_account FROM issuances ORDER BY id");

    const issuances: IssuanceSummary[] = issuanceRows.rows.map((r) => ({
      id: Number(r.id),
      kind: r.kind,
      ...(r.mpt_issuance_id !== null ? { mptIssuanceId: r.mpt_issuance_id } : {}),
      ...(r.currency !== null ? { currency: r.currency } : {}),
      ...(r.issuer_account !== null ? { issuer: r.issuer_account } : {}),
    }));

    const cov = await this.#db.query<{ lo: number | string | null; hi: number | string | null }>(
      "SELECT min(from_ledger) AS lo, max(to_ledger) AS hi FROM coverage",
    );
    const lo = cov.rows[0]?.lo;
    const hi = cov.rows[0]?.hi;
    const coverage =
      lo === null || lo === undefined || hi === null || hi === undefined
        ? null
        : { min: Number(lo), max: Number(hi) };

    return { issuances, coverage };
  }
}
