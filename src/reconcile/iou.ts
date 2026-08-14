import Big from "big.js";

import { asRecord, asString } from "../discovery/fields.js";
import { latestObjects, type MetaEntry } from "../api/state/reconstruct.js";
import { currencyToString } from "../xrpl/currency.js";

// Never emit exponential notation, so decimal strings stay Postgres numeric-safe.
Big.NE = -1_000_000;
Big.PE = 1_000_000;

export interface IouDelta {
  readonly account: string;
  /** Signed balance change as a plain decimal string. */
  readonly delta: string;
}

function amountIssuer(value: unknown): string | undefined {
  return asString(asRecord(value)?.["issuer"]);
}

function balanceValue(fields: Record<string, unknown>): string | undefined {
  return asString(asRecord(fields["Balance"])?.["value"]);
}

function balanceCurrency(fields: Record<string, unknown>): string | undefined {
  const c = asString(asRecord(fields["Balance"])?.["currency"]);
  return c === undefined ? undefined : currencyToString(c);
}

/**
 * The holder (the non-issuer party) and the sign of `Balance` from the holder's
 * perspective, for a RippleState of the given issuance. RippleState `Balance`
 * is from the low account's perspective, so a holder on the high side sees the
 * negated value. Returns null if this line does not belong to the issuance.
 */
export function holderInfo(
  fields: Record<string, unknown>,
  issuer: string,
  currency: string,
): { holder: string; sign: 1 | -1 } | null {
  if (balanceCurrency(fields) !== currency) return null;
  const low = amountIssuer(fields["LowLimit"]);
  const high = amountIssuer(fields["HighLimit"]);
  if (low === issuer && high !== undefined) return { holder: high, sign: -1 };
  if (high === issuer && low !== undefined) return { holder: low, sign: 1 };
  return null;
}

function holderBalance(fields: Record<string, unknown>, sign: 1 | -1): Big {
  const value = balanceValue(fields);
  const big = value === undefined ? new Big(0) : new Big(value);
  return sign === 1 ? big : big.times(-1);
}

/** Extract per-account IOU balance changes from a transaction's metadata. */
export function iouDeltas(
  meta: Record<string, unknown>,
  currency: string,
  issuer: string,
): IouDelta[] {
  const affected = meta["AffectedNodes"];
  if (!Array.isArray(affected)) return [];

  const deltas: IouDelta[] = [];
  for (const raw of affected) {
    const wrapper = asRecord(raw);
    if (!wrapper) continue;
    const created = asRecord(wrapper["CreatedNode"]);
    const modified = asRecord(wrapper["ModifiedNode"]);
    const deletedNode = asRecord(wrapper["DeletedNode"]);
    const node = created ?? modified ?? deletedNode;
    if (!node || asString(node["LedgerEntryType"]) !== "RippleState") continue;

    const fields = asRecord(node["FinalFields"]) ?? asRecord(node["NewFields"]);
    if (!fields) continue;
    const info = holderInfo(fields, issuer, currency);
    if (!info) continue;

    let prev: Big;
    let final: Big;
    if (created) {
      prev = new Big(0);
      final = holderBalance(fields, info.sign);
    } else if (modified) {
      const prevFields = asRecord(node["PreviousFields"]);
      if (!prevFields || asRecord(prevFields["Balance"]) === undefined) continue; // balance unchanged
      prev = holderBalance(prevFields, info.sign);
      final = holderBalance(fields, info.sign);
    } else {
      prev = holderBalance(fields, info.sign);
      final = new Big(0);
    }

    const delta = final.minus(prev);
    if (!delta.eq(0)) deltas.push({ account: info.holder, delta: delta.toString() });
  }
  return deltas;
}

/** Reconstruct current IOU balances per holder from RippleState objects. */
export function toIouBalances(
  entries: readonly MetaEntry[],
  issuer: string,
  currency: string,
): Map<string, Big> {
  const objects = latestObjects(
    entries,
    (type, fields) => type === "RippleState" && holderInfo(fields, issuer, currency) !== null,
  );
  const balances = new Map<string, Big>();
  for (const o of objects) {
    if (o.deleted) continue;
    const info = holderInfo(o.fields, issuer, currency);
    if (!info) continue;
    balances.set(info.holder, holderBalance(o.fields, info.sign));
  }
  return balances;
}
