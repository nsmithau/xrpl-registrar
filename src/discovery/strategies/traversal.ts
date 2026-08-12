import { pageAccountTx } from "../accountTx.js";
import { asRecord, asString, recordEarliest, toAccounts } from "../fields.js";
import type { AccountTxEntry, ClioReader, DiscoveredAccount } from "../types.js";

const AMOUNT_FIELDS = ["Amount", "SendMax", "DeliverMax"] as const;

/** Owners of `MPToken` nodes in a transaction's metadata that belong to the
 * given issuance — i.e. the holders a transfer actually touched. */
export function mptNodeOwners(entry: AccountTxEntry, mptIssuanceId: string): string[] {
  const owners: string[] = [];
  for (const raw of entry.meta?.AffectedNodes ?? []) {
    const wrapper = asRecord(raw);
    if (!wrapper) continue;
    const node =
      asRecord(wrapper.CreatedNode) ??
      asRecord(wrapper.ModifiedNode) ??
      asRecord(wrapper.DeletedNode);
    if (!node || asString(node.LedgerEntryType) !== "MPToken") continue;
    const fields = asRecord(node.FinalFields) ?? asRecord(node.NewFields);
    if (!fields || asString(fields.MPTokenIssuanceID) !== mptIssuanceId) continue;
    const owner = asString(fields.Account);
    if (owner) owners.push(owner);
  }
  return owners;
}

/** Whether a transaction concerns the given MPT issuance. */
export function isMptRelated(entry: AccountTxEntry, mptIssuanceId: string): boolean {
  const tx = asRecord(entry.tx_json);
  if (tx) {
    if (asString(tx.MPTokenIssuanceID) === mptIssuanceId) return true;
    for (const field of AMOUNT_FIELDS) {
      const amount = asRecord(tx[field]);
      if (amount && asString(amount.mpt_issuance_id) === mptIssuanceId) return true;
    }
  }
  return mptNodeOwners(entry, mptIssuanceId).length > 0;
}

/** The accounts a related transaction connects to. */
export function mptParties(entry: AccountTxEntry, mptIssuanceId: string): string[] {
  const parties = new Set<string>();
  const tx = asRecord(entry.tx_json);
  if (tx) {
    for (const field of ["Account", "Destination", "Holder"]) {
      const value = asString(tx[field]);
      if (value) parties.add(value);
    }
  }
  for (const owner of mptNodeOwners(entry, mptIssuanceId)) parties.add(owner);
  return [...parties];
}

/**
 * Traversal — the general algorithm, and the fallback for non-auth MPTs.
 *
 * Non-auth MPTs have no chokepoint: holder-to-holder transfers never touch the
 * issuer, so an issuer-scoped scan would be silently incomplete. Instead, walk
 * the transfer graph from the issuer, following any transaction that concerns
 * this issuance to its counterparties, to closure. Complete by construction:
 * every holder received the token from a prior holder, and every chain
 * originates at a mint from the issuer.
 */
export async function traversal(
  client: ClioReader,
  mptIssuanceId: string,
  issuer: string,
): Promise<DiscoveredAccount[]> {
  const first = new Map<string, number | null>();
  const seen = new Set<string>();
  const queued = new Set<string>([issuer]);
  const frontier: string[] = [issuer];
  recordEarliest(first, issuer, null);

  while (frontier.length > 0) {
    const account = frontier.shift() as string;
    if (seen.has(account)) continue;
    seen.add(account);

    for await (const entry of pageAccountTx(client, { account })) {
      if (!isMptRelated(entry, mptIssuanceId)) continue;
      const ledger = entry.ledger_index ?? null;
      for (const party of mptParties(entry, mptIssuanceId)) {
        recordEarliest(first, party, ledger);
        if (!seen.has(party) && !queued.has(party)) {
          queued.add(party);
          frontier.push(party);
        }
      }
    }
  }

  return toAccounts(first, "traversal");
}
