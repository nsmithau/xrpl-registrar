import { pageAccountTx } from "../accountTx.js";
import { asRecord, asString, recordEarliest, toAccounts } from "../fields.js";
import type { ClioReader, DiscoveredAccount } from "../types.js";

/**
 * Authorisation scan — for auth-required MPTs.
 *
 * Pages the issuer's `account_tx` filtered to `MPTokenAuthorize`, keeping only
 * rows for this issuance. Every account ever authorised to hold routes through
 * the issuer, so this yields a safe superset of every account that ever held:
 *
 *   - issuer authorises a holder → the row carries `Holder`;
 *   - a holder opts in themselves → `Account` is the holder.
 */
export async function authorizationScan(
  client: ClioReader,
  mptIssuanceId: string,
  issuer: string,
): Promise<DiscoveredAccount[]> {
  const first = new Map<string, number | null>();

  for await (const entry of pageAccountTx(client, {
    account: issuer,
    txType: "MPTokenAuthorize",
  })) {
    const tx = asRecord(entry.tx_json);
    if (!tx || asString(tx.MPTokenIssuanceID) !== mptIssuanceId) continue;

    const account = asString(tx.Account);
    const holder = asString(tx.Holder) ?? (account !== issuer ? account : undefined);
    if (holder) recordEarliest(first, holder, entry.ledger_index ?? null);
  }

  return toAccounts(first, "authorization");
}
