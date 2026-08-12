import type { Database } from "../../db/database.js";
import { invalidParams, notInArchive } from "../errors.js";
import type { ScopeRepository } from "../scope.js";
import { decodeMetaEntries, type MetaRow } from "../state/decode.js";
import { toMptHolders } from "../state/reconstruct.js";
import type { ApiRequest, MethodResult } from "../types.js";

/**
 * Archive-scoped `mpt_holders`. Reconstructs the MPToken holders of a tracked
 * issuance from the metadata of every archived transaction touching an in-scope
 * account for that issuance.
 *
 * Unlike Clio's point-in-time `mpt_holders`, the archive holds every account
 * ever in scope, so — evaluated at the latest ledger — this returns current
 * holders, and (with `ledger_index`) can answer holdership at any past ledger.
 */
export async function handleMptHolders(
  db: Database,
  scope: ScopeRepository,
  req: ApiRequest,
): Promise<MethodResult> {
  const mptId = typeof req.mpt_issuance_id === "string" ? req.mpt_issuance_id : undefined;
  if (!mptId) return { result: invalidParams("'mpt_issuance_id' is required") };

  const tracked = await db.query<{ id: number | string }>(
    "SELECT id FROM issuances WHERE mpt_issuance_id = $1",
    [mptId],
  );
  if (tracked.rows.length === 0) {
    return { result: notInArchive(`MPT issuance ${mptId}`, await scope.summarize()) };
  }
  const issuanceId = Number(tracked.rows[0]!.id);
  const upTo = typeof req.ledger_index === "number" ? req.ledger_index : Number.MAX_SAFE_INTEGER;

  // Every transaction touching an in-scope account for this issuance, deduped
  // by hash (a transaction may touch several in-scope accounts).
  const { rows } = await db.query<MetaRow>(
    `SELECT DISTINCT t.hash, t.meta_blob, t.ledger_index
     FROM transactions t
     JOIN account_transactions at ON at.hash = t.hash
     JOIN account_issuance ai ON ai.address = at.address
     WHERE ai.issuance_id = $1 AND t.ledger_index <= $2`,
    [issuanceId, upTo],
  );
  const entries = decodeMetaEntries(rows);
  const holders = toMptHolders(entries, mptId);

  return {
    result: {
      status: "success",
      mpt_issuance_id: mptId,
      mptokens: holders,
      validated: true,
    },
  };
}
