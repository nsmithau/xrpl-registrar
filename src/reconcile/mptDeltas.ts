import { asRecord, asString } from "../discovery/fields.js";

/**
 * Extract per-account MPT balance changes from a transaction's metadata.
 *
 * Each affected `MPToken` node gives the holder's balance before and after:
 * `PreviousFields.MPTAmount` (absent means it was the default 0) and
 * `FinalFields.MPTAmount`. MPT amounts are integers, so deltas are exact with
 * BigInt. A transfer produces two equal-and-opposite deltas; summing an
 * account's deltas over all its transactions reproduces its balance.
 */

export interface AccountDelta {
  readonly account: string;
  readonly delta: bigint;
}

function amount(value: unknown): bigint {
  const s = asString(value);
  if (s === undefined || s === "") return 0n;
  try {
    return BigInt(s);
  } catch {
    return 0n;
  }
}

export function mptDeltas(meta: Record<string, unknown>, mptIssuanceId: string): AccountDelta[] {
  const affected = meta["AffectedNodes"];
  if (!Array.isArray(affected)) return [];

  const deltas: AccountDelta[] = [];
  for (const raw of affected) {
    const wrapper = asRecord(raw);
    if (!wrapper) continue;

    const created = asRecord(wrapper["CreatedNode"]);
    const modified = asRecord(wrapper["ModifiedNode"]);
    const deletedNode = asRecord(wrapper["DeletedNode"]);
    const node = created ?? modified ?? deletedNode;
    if (!node || asString(node["LedgerEntryType"]) !== "MPToken") continue;

    const fields = asRecord(node["FinalFields"]) ?? asRecord(node["NewFields"]);
    if (!fields || asString(fields["MPTokenIssuanceID"]) !== mptIssuanceId) continue;

    const account = asString(fields["Account"]);
    if (!account) continue;

    let prev: bigint;
    let final: bigint;
    if (created) {
      prev = 0n;
      final = amount(fields["MPTAmount"]);
    } else if (modified) {
      prev = amount(asRecord(node["PreviousFields"])?.["MPTAmount"]);
      final = amount(fields["MPTAmount"]);
    } else {
      // Deleted: the object is removed, so the balance drops to zero.
      prev = amount(fields["MPTAmount"]);
      final = 0n;
    }

    const delta = final - prev;
    if (delta !== 0n) deltas.push({ account, delta });
  }
  return deltas;
}
