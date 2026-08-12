import type { Provenance } from "../../clio/types.js";
import type { Database } from "../database.js";

export interface IngestTransaction {
  readonly hash: string;
  readonly ledgerIndex: number;
  readonly ctid?: string | null;
  readonly closeTimeIso?: string | null;
  readonly txType: string;
  readonly mptIssuanceId?: string | null;
  /** Raw serialised transaction and metadata — retained so everything derived
   * is re-derivable. */
  readonly txBlob: Uint8Array;
  readonly metaBlob: Uint8Array;
  readonly provenance: Provenance;
  /** In-scope accounts this transaction is associated with. */
  readonly accounts: readonly string[];
}

/**
 * Persists transactions and their account associations.
 *
 * Ingest is **idempotent**: the transaction key is `hash` and the association
 * key is `(hash, address)`. Re-ingesting the same page — which backfill does on
 * resume after a mid-page kill — inserts nothing new and never duplicates. This
 * is what makes checkpoint-after-each-marker resumability safe.
 */
export class TransactionRepository {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async ingest(tx: IngestTransaction): Promise<void> {
    await this.#db.transaction(async (t) => {
      await t.query(
        `INSERT INTO transactions
           (hash, ledger_index, clio_ctid, close_time_iso, tx_type, mpt_issuance_id,
            tx_blob, meta_blob, source_endpoint, fetched_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (hash) DO NOTHING`,
        [
          tx.hash,
          tx.ledgerIndex,
          tx.ctid ?? null,
          tx.closeTimeIso ?? null,
          tx.txType,
          tx.mptIssuanceId ?? null,
          tx.txBlob,
          tx.metaBlob,
          tx.provenance.sourceEndpoint,
          tx.provenance.fetchedAt,
        ],
      );

      for (const address of tx.accounts) {
        // Accounts are append-only; keep the earliest ledger we have seen.
        await t.query(
          `INSERT INTO accounts (address, first_seen_ledger)
           VALUES ($1, $2)
           ON CONFLICT (address)
           DO UPDATE SET first_seen_ledger = LEAST(accounts.first_seen_ledger, EXCLUDED.first_seen_ledger)`,
          [address, tx.ledgerIndex],
        );
        await t.query(
          `INSERT INTO account_transactions (hash, address)
           VALUES ($1, $2)
           ON CONFLICT (hash, address) DO NOTHING`,
          [tx.hash, address],
        );
      }
    });
  }

  async countTransactions(): Promise<number> {
    const { rows } = await this.#db.query<{ n: number | string }>(
      "SELECT count(*)::bigint AS n FROM transactions",
    );
    return Number(rows[0]!.n);
  }
}
