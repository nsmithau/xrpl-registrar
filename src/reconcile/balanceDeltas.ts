import Big from "big.js";

import type { Database, Queryable } from "../db/database.js";

export interface DeltaRow {
  readonly hash: string;
  readonly address: string;
  /** Integer (MPT, bigint) or decimal (IOU, string) — stored as text either way. */
  readonly delta: bigint | string;
}

/**
 * Persists derived per-transaction balance deltas and sums them.
 *
 * Deltas are reproducible from raw blobs, so they are stored as a derived,
 * re-derivable table. The key is `(hash, address, issuance_id)`; re-derivation
 * overwrites with the same value, so it is idempotent.
 */
export class BalanceDeltaRepository {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /** Upsert a batch of deltas for an issuance in one transaction. Ensures the
   * account row exists first (deltas reference accounts). */
  async upsertMany(issuanceId: number, rows: readonly DeltaRow[]): Promise<void> {
    if (rows.length === 0) return;
    await this.#db.transaction(async (tx) => {
      for (const row of rows) await insertDelta(tx, issuanceId, row);
    });
  }

  /** Summed integer (MPT) balance per account, derived from the deltas. */
  async balanceByAccount(issuanceId: number): Promise<Map<string, bigint>> {
    const out = new Map<string, bigint>();
    for (const [address, bal] of await this.#sums(issuanceId)) out.set(address, BigInt(bal));
    return out;
  }

  /** Summed decimal (IOU) balance per account, derived from the deltas. */
  async decimalBalanceByAccount(issuanceId: number): Promise<Map<string, Big>> {
    const out = new Map<string, Big>();
    for (const [address, bal] of await this.#sums(issuanceId)) out.set(address, new Big(bal));
    return out;
  }

  async #sums(issuanceId: number): Promise<Array<[string, string]>> {
    const { rows } = await this.#db.query<{ address: string; bal: string }>(
      `SELECT address, sum(delta::numeric)::text AS bal
       FROM balance_deltas WHERE issuance_id = $1 GROUP BY address`,
      [issuanceId],
    );
    return rows.map((r) => [r.address, r.bal]);
  }

  async count(issuanceId: number): Promise<number> {
    const { rows } = await this.#db.query<{ n: number | string }>(
      "SELECT count(*)::bigint AS n FROM balance_deltas WHERE issuance_id = $1",
      [issuanceId],
    );
    return Number(rows[0]!.n);
  }
}

async function insertDelta(tx: Queryable, issuanceId: number, row: DeltaRow): Promise<void> {
  await tx.query(
    `INSERT INTO accounts (address) VALUES ($1) ON CONFLICT (address) DO NOTHING`,
    [row.address],
  );
  await tx.query(
    `INSERT INTO balance_deltas (hash, address, issuance_id, delta)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (hash, address, issuance_id) DO UPDATE SET delta = EXCLUDED.delta`,
    [row.hash, row.address, issuanceId, row.delta.toString()],
  );
}
