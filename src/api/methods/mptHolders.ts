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
  const requested = typeof req.ledger_index === "number" ? req.ledger_index : undefined;
  const upTo = requested ?? Number.MAX_SAFE_INTEGER;

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
  const all = toMptHolders(entries, mptId);

  // Clio paginates `mpt_holders` (default page 50, marker on overflow). Order by
  // the MPToken object id for a stable cursor and echo `limit`/`marker` so a
  // paginating Clio/xrpl.js client works unchanged.
  const limit = Math.max(1, Math.min(400, typeof req.limit === "number" ? req.limit : 50));
  const marker = typeof req.marker === "string" ? req.marker : undefined;
  const ordered = all
    .slice()
    .sort((a, b) => (a.mptoken_index < b.mptoken_index ? -1 : a.mptoken_index > b.mptoken_index ? 1 : 0));
  const after = marker ? ordered.filter((h) => h.mptoken_index > marker) : ordered;
  const page = after.slice(0, limit);
  const nextMarker = after.length > limit ? page[page.length - 1]!.mptoken_index : undefined;

  // The ledger this holdership is as of: the requested ledger, else the archive's
  // latest validated ledger (so the client learns the snapshot's point in time).
  const ledgerIndex = requested ?? (await latestLedger(db));

  return {
    result: {
      status: "success",
      mpt_issuance_id: mptId,
      ledger_index: ledgerIndex,
      limit,
      mptokens: page,
      ...(nextMarker !== undefined ? { marker: nextMarker } : {}),
      validated: true,
    },
  };
}

/** The archive's latest validated ledger: the tail's high-water if it has run,
 * else the newest ledger any archived transaction lands in. */
async function latestLedger(db: Database): Promise<number> {
  const { rows } = await db.query<{ hi: number | string | null }>(
    `SELECT max(hi) AS hi FROM (
       SELECT max(ledger_index) AS hi FROM ledgers
       UNION ALL SELECT max(ledger_index) FROM transactions
     ) x`,
  );
  return rows[0]?.hi != null ? Number(rows[0]!.hi) : 0;
}
