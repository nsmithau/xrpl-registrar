import type { AccountTxEntry, ClioReader } from "./types.js";

export interface AccountTxQuery {
  readonly account: string;
  /** Clio `tx_type` filter (Clio 2.0+), e.g. "MPTokenAuthorize", "TrustSet". */
  readonly txType?: string;
  /** Page size passed upstream. */
  readonly limit?: number;
}

interface AccountTxPage {
  transactions?: AccountTxEntry[];
  marker?: unknown;
}

/**
 * Iterate an account's transactions forward, following the `marker` across
 * pages until exhausted. Every page goes through the governed client, so the
 * global concurrency/backoff limits apply to discovery for free.
 */
export async function* pageAccountTx(
  client: ClioReader,
  query: AccountTxQuery,
): AsyncGenerator<AccountTxEntry> {
  let marker: unknown = undefined;
  for (;;) {
    const req = {
      command: "account_tx",
      account: query.account,
      forward: true,
      ...(query.txType !== undefined ? { tx_type: query.txType } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
      ...(marker !== undefined ? { marker } : {}),
    };
    const res = await client.request<AccountTxPage>(req);
    for (const entry of res.result.transactions ?? []) {
      yield entry;
    }
    if (res.result.marker === undefined) return;
    marker = res.result.marker;
  }
}
