import { currencyToString } from "../../xrpl/currency.js";
import { pageAccountTx } from "../accountTx.js";
import { asRecord, asString, recordEarliest, toAccounts } from "../fields.js";
import type { ClioReader, DiscoveredAccount } from "../types.js";

/**
 * Trustline scan — for IOUs.
 *
 * Pages the issuer's `account_tx` filtered to `TrustSet`. A `TrustSet` appears
 * in the *issuer's* `account_tx` even when submitted by the holder, so the
 * `Account` on each matching row is every account that ever opened a line to
 * this issuer for this currency.
 */
export async function trustlineScan(
  client: ClioReader,
  currency: string,
  issuer: string,
): Promise<DiscoveredAccount[]> {
  const first = new Map<string, number | null>();

  for await (const entry of pageAccountTx(client, { account: issuer, txType: "TrustSet" })) {
    const tx = asRecord(entry.tx_json);
    const limit = tx ? asRecord(tx.LimitAmount) : undefined;
    if (!tx || !limit) continue;
    if (asString(limit.issuer) !== issuer) continue;
    if (currencyToString(asString(limit.currency) ?? "") !== currency) continue;

    const account = asString(tx.Account);
    if (account && account !== issuer) recordEarliest(first, account, entry.ledger_index ?? null);
  }

  return toAccounts(first, "trustline");
}
