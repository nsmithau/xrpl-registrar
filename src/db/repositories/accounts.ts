import type { DiscoveredAccount } from "../../discovery/types.js";
import type { Database } from "../database.js";

export interface AccountIssuanceRow {
  readonly address: string;
  readonly discoveredVia: string;
  readonly firstAcquisitionLedger: number | null;
}

/** Persists discovered accounts and their membership in an issuance. */
export class AccountRepository {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /**
   * Upsert accounts (append-only, earliest ledger wins) and their
   * `account_issuance` membership. Idempotent — safe to re-run discovery.
   */
  async recordDiscovered(
    issuanceId: number,
    accounts: readonly DiscoveredAccount[],
  ): Promise<void> {
    await this.#db.transaction(async (tx) => {
      for (const account of accounts) {
        await tx.query(
          `INSERT INTO accounts (address, first_seen_ledger)
           VALUES ($1, $2)
           ON CONFLICT (address)
           DO UPDATE SET first_seen_ledger =
             LEAST(accounts.first_seen_ledger, EXCLUDED.first_seen_ledger)`,
          [account.address, account.firstAcquisitionLedger],
        );
        await tx.query(
          `INSERT INTO account_issuance
             (address, issuance_id, discovered_via, first_acquisition_ledger)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (address, issuance_id)
           DO UPDATE SET first_acquisition_ledger =
             LEAST(account_issuance.first_acquisition_ledger, EXCLUDED.first_acquisition_ledger)`,
          [account.address, issuanceId, account.discoveredVia, account.firstAcquisitionLedger],
        );
      }
    });
  }

  async countForIssuance(issuanceId: number): Promise<number> {
    const { rows } = await this.#db.query<{ n: number | string }>(
      "SELECT count(*)::bigint AS n FROM account_issuance WHERE issuance_id = $1",
      [issuanceId],
    );
    return Number(rows[0]!.n);
  }

  async listForIssuance(issuanceId: number): Promise<AccountIssuanceRow[]> {
    const { rows } = await this.#db.query<{
      address: string;
      discovered_via: string;
      first_acquisition_ledger: number | string | null;
    }>(
      `SELECT address, discovered_via, first_acquisition_ledger
       FROM account_issuance WHERE issuance_id = $1 ORDER BY address`,
      [issuanceId],
    );
    return rows.map((r) => ({
      address: r.address,
      discoveredVia: r.discovered_via,
      firstAcquisitionLedger:
        r.first_acquisition_ledger === null ? null : Number(r.first_acquisition_ledger),
    }));
  }
}
