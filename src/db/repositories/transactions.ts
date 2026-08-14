import type { Provenance } from "../../clio/types.js";
import type { Database, Queryable } from "../database.js";

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
 * Insert a transaction and its account associations using the given queryable
 * (a connection or an open transaction).
 *
 * Idempotent: the transaction key is `hash` and the association key is
 * `(hash, address)`. Re-inserting the same page — which backfill does on resume
 * after a mid-page kill — inserts nothing new and never duplicates. Because it
 * takes a `Queryable`, a whole page can be inserted and its marker checkpointed
 * inside one transaction, which is what makes resumability exact.
 */
export async function insertTransactionRows(q: Queryable, tx: IngestTransaction): Promise<void> {
  await q.query(
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
    await q.query(
      `INSERT INTO accounts (address, first_seen_ledger)
       VALUES ($1, $2)
       ON CONFLICT (address)
       DO UPDATE SET first_seen_ledger = LEAST(accounts.first_seen_ledger, EXCLUDED.first_seen_ledger)`,
      [address, tx.ledgerIndex],
    );
    await q.query(
      `INSERT INTO account_transactions (hash, address)
       VALUES ($1, $2)
       ON CONFLICT (hash, address) DO NOTHING`,
      [tx.hash, address],
    );
  }
}

/**
 * Batch version of {@link insertTransactionRows}: insert many transactions and
 * their account associations with one multi-row statement per table, instead of
 * O(rows) individual statements. This is the hot path for backfill and gap heal
 * — a page of ~200 transactions collapses from ~600+ statements to ~3, which
 * matters because the query engine (in-process PGlite) runs on the main thread.
 * Same idempotency as the single-row version. Multi-row statements are chunked
 * to stay under the parameter limit.
 */
export async function insertTransactionRowsMany(
  q: Queryable,
  txs: readonly IngestTransaction[],
): Promise<void> {
  if (txs.length === 0) return;

  // transactions — one row per distinct hash. Insert before account_transactions
  // (which references it).
  const seenTx = new Set<string>();
  const txRows = txs.filter((tx) => (seenTx.has(tx.hash) ? false : (seenTx.add(tx.hash), true)));
  await insertChunked(
    q,
    10,
    txRows,
    `INSERT INTO transactions
       (hash, ledger_index, clio_ctid, close_time_iso, tx_type, mpt_issuance_id,
        tx_blob, meta_blob, source_endpoint, fetched_at) VALUES `,
    ` ON CONFLICT (hash) DO NOTHING`,
    (tx) => [
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

  // accounts — one row per distinct address, keeping the earliest ledger seen.
  const earliest = new Map<string, number>();
  for (const tx of txs) {
    for (const address of tx.accounts) {
      earliest.set(address, Math.min(earliest.get(address) ?? tx.ledgerIndex, tx.ledgerIndex));
    }
  }
  await insertChunked(
    q,
    2,
    [...earliest],
    `INSERT INTO accounts (address, first_seen_ledger) VALUES `,
    ` ON CONFLICT (address) DO UPDATE SET first_seen_ledger = LEAST(accounts.first_seen_ledger, EXCLUDED.first_seen_ledger)`,
    ([address, ledger]) => [address, ledger],
  );

  // account_transactions — distinct (hash, address) links.
  const seenLink = new Set<string>();
  const links: Array<[string, string]> = [];
  for (const tx of txs) {
    for (const address of tx.accounts) {
      const key = `${tx.hash}|${address}`;
      if (!seenLink.has(key)) {
        seenLink.add(key);
        links.push([tx.hash, address]);
      }
    }
  }
  await insertChunked(
    q,
    2,
    links,
    `INSERT INTO account_transactions (hash, address) VALUES `,
    ` ON CONFLICT (hash, address) DO NOTHING`,
    ([hash, address]) => [hash, address],
  );
}

/** Execute a multi-row INSERT in chunks that stay under Postgres's 65535-param
 * limit (~60000/columns rows per statement). */
async function insertChunked<T>(
  q: Queryable,
  columns: number,
  rows: readonly T[],
  prefix: string,
  suffix: string,
  toParams: (row: T) => unknown[],
): Promise<void> {
  if (rows.length === 0) return;
  const perStatement = Math.max(1, Math.floor(60_000 / columns));
  for (let start = 0; start < rows.length; start += perStatement) {
    const chunk = rows.slice(start, start + perStatement);
    const params: unknown[] = [];
    const groups = chunk.map((row) => {
      const values = toParams(row);
      const placeholders = values.map((_, i) => `$${params.length + i + 1}`);
      params.push(...values);
      return `(${placeholders.join(", ")})`;
    });
    await q.query(prefix + groups.join(", ") + suffix, params);
  }
}

/** Persists transactions and their account associations. */
export class TransactionRepository {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async ingest(tx: IngestTransaction): Promise<void> {
    await this.#db.transaction((t) => insertTransactionRows(t, tx));
  }

  async countTransactions(): Promise<number> {
    const { rows } = await this.#db.query<{ n: number | string }>(
      "SELECT count(*)::bigint AS n FROM transactions",
    );
    return Number(rows[0]!.n);
  }
}
