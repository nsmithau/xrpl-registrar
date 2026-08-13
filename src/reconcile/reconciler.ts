import { decodeMetaEntries, type MetaRow } from "../api/state/decode.js";
import { toMptHolders } from "../api/state/reconstruct.js";
import type { Database } from "../db/database.js";

import { BalanceDeltaRepository } from "./balanceDeltas.js";

export interface Discrepancy {
  readonly account: string;
  readonly derived: string;
  readonly reconstructed: string;
}

export interface ReconciliationReport {
  readonly runId: number;
  readonly issuanceId: number;
  readonly passed: boolean;
  readonly discrepancies: Discrepancy[];
}

/**
 * Compare two balance maps: the derived balances (summed deltas) against the
 * reconstructed balances (latest object state). Both come from the same
 * metadata by different routes, so they must agree — a difference is a defect
 * in the derivation, surfaced rather than swallowed.
 */
export function compareBalances(
  derived: Map<string, bigint>,
  reconstructed: Map<string, bigint>,
): Discrepancy[] {
  const accounts = new Set([...derived.keys(), ...reconstructed.keys()]);
  const out: Discrepancy[] = [];
  for (const account of [...accounts].sort()) {
    const d = derived.get(account) ?? 0n;
    const r = reconstructed.get(account) ?? 0n;
    if (d !== r) out.push({ account, derived: d.toString(), reconstructed: r.toString() });
  }
  return out;
}

/**
 * Reconciles an issuance's derived balances against the ledger state
 * reconstructed from metadata, on demand, and records the outcome in
 * `reconciliation_run`.
 */
export class Reconciler {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async runMpt(issuanceId: number, mptIssuanceId: string): Promise<ReconciliationReport> {
    const derived = await new BalanceDeltaRepository(this.#db).balanceByAccount(issuanceId);

    const { rows } = await this.#db.query<MetaRow>(
      `SELECT DISTINCT t.hash, t.meta_blob, t.ledger_index
       FROM transactions t
       JOIN account_transactions at ON at.hash = t.hash
       JOIN account_issuance ai ON ai.address = at.address
       WHERE ai.issuance_id = $1`,
      [issuanceId],
    );
    const holders = toMptHolders(decodeMetaEntries(rows), mptIssuanceId);
    const reconstructed = new Map(holders.map((h) => [h.account, BigInt(h.mpt_amount)]));

    const discrepancies = compareBalances(derived, reconstructed);
    const passed = discrepancies.length === 0;

    const inserted = await this.#db.query<{ id: number | string }>(
      `INSERT INTO reconciliation_run (issuance_id, passed, discrepancies)
       VALUES ($1, $2, $3) RETURNING id`,
      [issuanceId, passed, discrepancies.length],
    );

    return { runId: Number(inserted.rows[0]!.id), issuanceId, passed, discrepancies };
  }
}
