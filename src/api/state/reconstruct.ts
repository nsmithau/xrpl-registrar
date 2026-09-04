import { asRecord, asString } from "../../discovery/fields.js";

/**
 * Reconstruct ledger-object state from transaction metadata.
 *
 * Each affected node in a transaction's metadata carries the object's fields
 * *after* that transaction (`FinalFields` for modifications, `NewFields` for
 * creations). So the latest transaction to touch an object — by ledger, then by
 * in-ledger `TransactionIndex` — holds its current state, and a `DeletedNode`
 * means it is gone. Walking an account's (or issuance's) archived transactions
 * this way rebuilds current or as-of-ledger state without replaying deltas,
 * entirely from retained blobs.
 */

export interface MetaEntry {
  readonly ledgerIndex: number;
  readonly transactionIndex: number;
  readonly meta: Record<string, unknown>;
}

interface NodeInfo {
  readonly entryType: string;
  readonly objectId: string;
  readonly fields: Record<string, unknown>;
  readonly deleted: boolean;
}

export interface ObjectState {
  readonly objectId: string;
  readonly entryType: string;
  readonly fields: Record<string, unknown>;
  readonly deleted: boolean;
  readonly ledgerIndex: number;
  readonly transactionIndex: number;
}

function extractNodes(meta: Record<string, unknown>): NodeInfo[] {
  const affected = meta["AffectedNodes"];
  if (!Array.isArray(affected)) return [];
  const out: NodeInfo[] = [];
  for (const raw of affected) {
    const wrapper = asRecord(raw);
    if (!wrapper) continue;
    let node = asRecord(wrapper["CreatedNode"]) ?? asRecord(wrapper["ModifiedNode"]);
    let deleted = false;
    if (!node) {
      node = asRecord(wrapper["DeletedNode"]);
      deleted = true;
    }
    if (!node) continue;
    const entryType = asString(node["LedgerEntryType"]);
    const objectId = asString(node["LedgerIndex"]);
    const fields = asRecord(node["FinalFields"]) ?? asRecord(node["NewFields"]) ?? {};
    if (!entryType || !objectId) continue;
    out.push({ entryType, objectId, fields, deleted });
  }
  return out;
}

/** Latest state per object id, over the given entries, for matching nodes. */
export function latestObjects(
  entries: readonly MetaEntry[],
  predicate: (entryType: string, fields: Record<string, unknown>) => boolean,
): ObjectState[] {
  const byId = new Map<string, ObjectState>();
  for (const entry of entries) {
    for (const node of extractNodes(entry.meta)) {
      if (!predicate(node.entryType, node.fields)) continue;
      const prev = byId.get(node.objectId);
      const isNewer =
        !prev ||
        entry.ledgerIndex > prev.ledgerIndex ||
        (entry.ledgerIndex === prev.ledgerIndex && entry.transactionIndex > prev.transactionIndex);
      if (isNewer) {
        byId.set(node.objectId, {
          objectId: node.objectId,
          entryType: node.entryType,
          fields: node.fields,
          deleted: node.deleted,
          ledgerIndex: entry.ledgerIndex,
          transactionIndex: entry.transactionIndex,
        });
      }
    }
  }
  return [...byId.values()];
}

function num(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

/** The AccountRoot state for an account (its `account_data`), or null. */
export function toAccountData(
  entries: readonly MetaEntry[],
  account: string,
): Record<string, unknown> | null {
  const objects = latestObjects(
    entries,
    (type, fields) => type === "AccountRoot" && asString(fields["Account"]) === account,
  );
  const live = objects.find((o) => !o.deleted);
  return live ? live.fields : null;
}

export interface MptHolder {
  readonly account: string;
  readonly mpt_amount: string;
  readonly flags: number;
  readonly mptoken_index: string;
}

/** Current MPToken holders of an issuance. */
export function toMptHolders(entries: readonly MetaEntry[], mptIssuanceId: string): MptHolder[] {
  const objects = latestObjects(
    entries,
    (type, fields) => type === "MPToken" && asString(fields["MPTokenIssuanceID"]) === mptIssuanceId,
  );
  const holders: MptHolder[] = [];
  for (const o of objects) {
    if (o.deleted) continue;
    const account = asString(o.fields["Account"]);
    if (!account) continue;
    holders.push({
      account,
      mpt_amount: asString(o.fields["MPTAmount"]) ?? "0",
      flags: num(o.fields["Flags"]) ?? 0,
      mptoken_index: o.objectId,
    });
  }
  return holders.sort((a, b) => (a.account < b.account ? -1 : a.account > b.account ? 1 : 0));
}

export interface AccountLine {
  readonly account: string;
  readonly currency: string;
  readonly balance: string;
  readonly limit: string;
  readonly limit_peer: string;
}

function amountValue(v: unknown): string {
  const rec = asRecord(v);
  return (rec ? asString(rec["value"]) : undefined) ?? "0";
}

function amountIssuer(v: unknown): string | undefined {
  const rec = asRecord(v);
  return rec ? asString(rec["issuer"]) : undefined;
}

function negate(value: string): string {
  if (value === "0") return "0";
  return value.startsWith("-") ? value.slice(1) : `-${value}`;
}

/** Trustlines for an account, reconstructed from RippleState objects. */
export function toAccountLines(entries: readonly MetaEntry[], account: string): AccountLine[] {
  const objects = latestObjects(entries, (type, fields) => {
    if (type !== "RippleState") return false;
    return (
      amountIssuer(fields["HighLimit"]) === account || amountIssuer(fields["LowLimit"]) === account
    );
  });

  const lines: AccountLine[] = [];
  for (const o of objects) {
    if (o.deleted) continue;
    const balance = asRecord(o.fields["Balance"]);
    const currency = (balance ? asString(balance["currency"]) : undefined) ?? "";
    const isLow = amountIssuer(o.fields["LowLimit"]) === account;
    const rawBalance = amountValue(o.fields["Balance"]);
    lines.push({
      // From this account's perspective the counterparty is the other side.
      account:
        (isLow ? amountIssuer(o.fields["HighLimit"]) : amountIssuer(o.fields["LowLimit"])) ?? "",
      currency,
      balance: isLow ? rawBalance : negate(rawBalance),
      limit: amountValue(isLow ? o.fields["LowLimit"] : o.fields["HighLimit"]),
      limit_peer: amountValue(isLow ? o.fields["HighLimit"] : o.fields["LowLimit"]),
    });
  }
  return lines.sort((a, b) => (a.account < b.account ? -1 : a.account > b.account ? 1 : 0));
}
