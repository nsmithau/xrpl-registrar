import { decode } from "xrpl";

import type { Queryable } from "../db/database.js";
import type { IssuanceRecord } from "../db/repositories/issuances.js";
import { asRecord } from "../discovery/fields.js";
import { bytesToHex } from "../util/hex.js";

import { insertDelta } from "./balanceDeltas.js";
import { iouDeltas } from "./iou.js";
import { mptDeltas } from "./mptDeltas.js";

/** The minimum an issuance needs for per-transaction delta derivation. */
export interface TrackedIssuance {
  readonly id: number;
  readonly kind: "mpt" | "iou";
  readonly mptIssuanceId?: string | null;
  readonly currency?: string | null;
  readonly issuer?: string | null;
}

/** A hook the ingest paths call to derive a transaction's deltas as it lands,
 * on the same DB transaction as the insert (so rows and deltas commit together).
 * The default is a no-op. */
export type DeriveDeltas = (q: Queryable, hash: string, metaBlob: Uint8Array) => Promise<void>;

export const noopDeriveDeltas: DeriveDeltas = () => Promise.resolve();

export function trackedIssuance(i: IssuanceRecord): TrackedIssuance {
  return { id: i.id, kind: i.kind, mptIssuanceId: i.mptIssuanceId, currency: i.currency, issuer: i.issuerAccount };
}

/**
 * Derive one transaction's per-account balance deltas across the given
 * issuances and upsert them on `q` (the caller's transaction). This is the
 * incremental counterpart to the batch `deriveMptDeltas`/`deriveIouDeltas`: it
 * lets every ingest path — backfill, live tail, gap heal — keep `balance_deltas`
 * current at ingest time, instead of a periodic full re-scan of all history.
 *
 * Idempotent: a re-ingested transaction overwrites its deltas with the same
 * values. Returns the number of delta rows written.
 */
export async function deriveTxDeltas(
  q: Queryable,
  issuances: readonly TrackedIssuance[],
  hash: string,
  metaBlob: Uint8Array,
): Promise<number> {
  if (issuances.length === 0 || metaBlob.length === 0) return 0;
  const meta = asRecord(decode(bytesToHex(metaBlob)));
  if (!meta) return 0;

  let written = 0;
  for (const iss of issuances) {
    const deltas =
      iss.kind === "mpt"
        ? mptDeltas(meta, iss.mptIssuanceId ?? "")
        : iouDeltas(meta, iss.currency ?? "", iss.issuer ?? "");
    for (const d of deltas) {
      await insertDelta(q, iss.id, { hash, address: d.account, delta: d.delta });
      written += 1;
    }
  }
  return written;
}

/** Build a {@link DeriveDeltas} hook bound to a fixed set of issuances (backfill,
 * where the issuance is known) or to a live getter (the tail, where the tracked
 * set grows as issuances register). */
export function deltaDeriver(issuances: readonly TrackedIssuance[] | (() => readonly TrackedIssuance[])): DeriveDeltas {
  const resolve = typeof issuances === "function" ? issuances : () => issuances;
  return (q, hash, metaBlob) => deriveTxDeltas(q, resolve(), hash, metaBlob).then(() => undefined);
}
