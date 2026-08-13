import { decode } from "xrpl";

import { asRecord } from "../discovery/fields.js";
import type { Database, Row } from "../db/database.js";
import { bytesToHex } from "../util/hex.js";

import { BalanceDeltaRepository, type DeltaRow } from "./balanceDeltas.js";
import { iouDeltas } from "./iou.js";
import { mptDeltas } from "./mptDeltas.js";

interface DeriveRow extends Row {
  hash: string;
  meta_blob: Uint8Array;
}

async function inScopeMeta(db: Database, issuanceId: number): Promise<DeriveRow[]> {
  const { rows } = await db.query<DeriveRow>(
    `SELECT DISTINCT t.hash, t.meta_blob
     FROM transactions t
     JOIN account_transactions at ON at.hash = t.hash
     JOIN account_issuance ai ON ai.address = at.address
     WHERE ai.issuance_id = $1`,
    [issuanceId],
  );
  return rows;
}

/**
 * Derive and persist per-account balance deltas for an MPT issuance from the
 * metadata of every archived transaction touching an in-scope account.
 * Idempotent: re-running overwrites each delta with the same value. Returns the
 * number of delta rows written.
 */
export async function deriveMptDeltas(
  db: Database,
  issuanceId: number,
  mptIssuanceId: string,
): Promise<number> {
  const deltaRows: DeltaRow[] = [];
  for (const row of await inScopeMeta(db, issuanceId)) {
    const meta = asRecord(decode(bytesToHex(row.meta_blob)));
    if (!meta) continue;
    for (const d of mptDeltas(meta, mptIssuanceId)) {
      deltaRows.push({ hash: row.hash, address: d.account, delta: d.delta });
    }
  }
  await new BalanceDeltaRepository(db).upsertMany(issuanceId, deltaRows);
  return deltaRows.length;
}

/**
 * Derive and persist IOU (trustline) balance deltas for an issuance. Same shape
 * as the MPT path, but deltas are decimal strings (values are decimal).
 */
export async function deriveIouDeltas(
  db: Database,
  issuanceId: number,
  currency: string,
  issuer: string,
): Promise<number> {
  const deltaRows: DeltaRow[] = [];
  for (const row of await inScopeMeta(db, issuanceId)) {
    const meta = asRecord(decode(bytesToHex(row.meta_blob)));
    if (!meta) continue;
    for (const d of iouDeltas(meta, currency, issuer)) {
      deltaRows.push({ hash: row.hash, address: d.account, delta: d.delta });
    }
  }
  await new BalanceDeltaRepository(db).upsertMany(issuanceId, deltaRows);
  return deltaRows.length;
}
