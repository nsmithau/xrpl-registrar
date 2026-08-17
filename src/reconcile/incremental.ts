import { decode } from "xrpl";

import type { Queryable } from "../db/database.js";
import type { IssuanceRecord } from "../db/repositories/issuances.js";
import { asRecord, asString } from "../discovery/fields.js";
import { bytesToHex } from "../util/hex.js";

import { insertDeltasMany } from "./balanceDeltas.js";
import { holderInfo, iouDeltas } from "./iou.js";
import { mptDeltas } from "./mptDeltas.js";

/** The minimum an issuance needs for per-transaction delta derivation. */
export interface TrackedIssuance {
  readonly id: number;
  readonly kind: "mpt" | "iou";
  readonly mptIssuanceId?: string | null;
  readonly currency?: string | null;
  readonly issuer?: string | null;
}

/** A transaction's decoded metadata, or null for an empty/undecodable blob.
 * Decoding is the CPU-dominant step of ingest, so it is done once per
 * transaction and this shared object is threaded to every consumer. */
export type DecodedMeta = Record<string, unknown> | null;

/** Decode a stored `meta_blob` once. Returns null for an empty or undecodable
 * blob so callers can skip cheaply — a single malformed blob is skipped (its raw
 * bytes are retained and remain re-derivable) rather than crashing the ingest. */
export function decodeMeta(metaBlob: Uint8Array): DecodedMeta {
  if (metaBlob.length === 0) return null;
  try {
    return asRecord(decode(bytesToHex(metaBlob))) ?? null;
  } catch {
    return null;
  }
}

/** A hook the ingest paths call to derive a transaction's deltas as it lands,
 * on the same DB transaction as the insert (so rows and deltas commit together).
 * Takes the already-decoded metadata (decoded once per transaction upstream).
 * The default is a no-op. */
export type DeriveDeltas = (q: Queryable, hash: string, meta: DecodedMeta) => Promise<void>;

export const noopDeriveDeltas: DeriveDeltas = () => Promise.resolve();

export function trackedIssuance(i: IssuanceRecord): TrackedIssuance {
  return { id: i.id, kind: i.kind, mptIssuanceId: i.mptIssuanceId, currency: i.currency, issuer: i.issuerAccount };
}

/**
 * Derive one transaction's per-account balance deltas across the given
 * issuances (from already-decoded metadata) and upsert them on `q` (the
 * caller's transaction). This is the incremental counterpart to the batch
 * `deriveMptDeltas`/`deriveIouDeltas`: it lets every ingest path — backfill,
 * live tail, gap heal — keep `balance_deltas` current at ingest time, instead of
 * a periodic full re-scan of all history.
 *
 * Idempotent: a re-ingested transaction overwrites its deltas with the same
 * values. Returns the number of delta rows written.
 */
export async function deriveTxDeltasFromMeta(
  q: Queryable,
  issuances: readonly TrackedIssuance[],
  hash: string,
  meta: DecodedMeta,
): Promise<number> {
  if (issuances.length === 0 || !meta) return 0;

  let written = 0;
  for (const iss of issuances) {
    const deltas =
      iss.kind === "mpt"
        ? mptDeltas(meta, iss.mptIssuanceId ?? "")
        : iouDeltas(meta, iss.currency ?? "", iss.issuer ?? "");
    if (deltas.length === 0) continue;
    await insertDeltasMany(
      q,
      iss.id,
      deltas.map((d) => ({ hash, address: d.account, delta: d.delta })),
    );
    written += deltas.length;
  }
  return written;
}

/** {@link deriveTxDeltasFromMeta} from a raw (undecoded) metadata blob — for
 * callers that hold only bytes (batch re-derivation, tests). */
export function deriveTxDeltas(
  q: Queryable,
  issuances: readonly TrackedIssuance[],
  hash: string,
  metaBlob: Uint8Array,
): Promise<number> {
  return deriveTxDeltasFromMeta(q, issuances, hash, decodeMeta(metaBlob));
}

/** A holder of a tracked issuance found in a transaction's metadata. */
export interface DetectedHolder {
  readonly issuanceId: number;
  readonly holder: string;
}

/**
 * Find every account holding a tracked issuance's token that appears in a
 * transaction's metadata — the basis for streaming discovery: the live tail,
 * subscribed to the issuer, sees a new holder's first `MPToken` / `RippleState`
 * node here before that account is otherwise known. Includes zero-balance
 * opt-ins (unlike delta derivation, which only reports balance changes).
 */
export function holdersInMeta(
  meta: Record<string, unknown>,
  issuances: readonly TrackedIssuance[],
): DetectedHolder[] {
  const affected = meta["AffectedNodes"];
  if (!Array.isArray(affected)) return [];

  const out: DetectedHolder[] = [];
  const seen = new Set<string>();
  for (const raw of affected) {
    const wrapper = asRecord(raw);
    const node =
      asRecord(wrapper?.["CreatedNode"]) ??
      asRecord(wrapper?.["ModifiedNode"]) ??
      asRecord(wrapper?.["DeletedNode"]);
    const type = node ? asString(node["LedgerEntryType"]) : undefined;
    const fields = node ? (asRecord(node["FinalFields"]) ?? asRecord(node["NewFields"])) : undefined;
    if (!fields) continue;

    for (const iss of issuances) {
      let holder: string | undefined;
      if (iss.kind === "mpt" && type === "MPToken" && asString(fields["MPTokenIssuanceID"]) === (iss.mptIssuanceId ?? "")) {
        holder = asString(fields["Account"]);
      } else if (iss.kind === "iou" && type === "RippleState") {
        holder = holderInfo(fields, iss.issuer ?? "", iss.currency ?? "")?.holder;
      }
      if (!holder) continue;
      const key = `${iss.id}|${holder}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ issuanceId: iss.id, holder });
    }
  }
  return out;
}

/** {@link holdersInMeta} from a raw (undecoded) metadata blob. */
export function holdersInMetaBlob(
  metaBlob: Uint8Array,
  issuances: readonly TrackedIssuance[],
): DetectedHolder[] {
  if (metaBlob.length === 0 || issuances.length === 0) return [];
  const meta = asRecord(decode(bytesToHex(metaBlob)));
  return meta ? holdersInMeta(meta, issuances) : [];
}

/** Build a {@link DeriveDeltas} hook bound to a fixed set of issuances (backfill,
 * where the issuance is known) or to a live getter (the tail, where the tracked
 * set grows as issuances register). */
export function deltaDeriver(issuances: readonly TrackedIssuance[] | (() => readonly TrackedIssuance[])): DeriveDeltas {
  const resolve = typeof issuances === "function" ? issuances : () => issuances;
  return (q, hash, meta) => deriveTxDeltasFromMeta(q, resolve(), hash, meta).then(() => undefined);
}
