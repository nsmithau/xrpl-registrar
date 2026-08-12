import { currencyToString } from "../xrpl/currency.js";

import { asRecord, asString } from "./fields.js";
import type { ClioReader } from "./types.js";

interface AccountLinesPage {
  lines?: unknown[];
  marker?: unknown;
}

/** Iterate an account's trustlines, following the `marker` across pages. */
export async function* pageAccountLines(
  client: ClioReader,
  account: string,
): AsyncGenerator<Record<string, unknown>> {
  let marker: unknown = undefined;
  for (;;) {
    const req = {
      command: "account_lines",
      account,
      ...(marker !== undefined ? { marker } : {}),
    };
    const res = await client.request<AccountLinesPage>(req);
    for (const line of res.result.lines ?? []) {
      const record = asRecord(line);
      if (record) yield record;
    }
    if (res.result.marker === undefined) return;
    marker = res.result.marker;
  }
}

/**
 * The issuer's *current* trustline holders for a currency — one cheap paginated
 * call (`account_lines`), the IOU analogue of `mpt_holders`. Point-in-time: it
 * omits accounts that opened a line and later closed it, so it is a fast seed
 * and cross-check, never the complete historical set.
 */
export async function currentTrustlineHolders(
  client: ClioReader,
  issuer: string,
  currency: string,
): Promise<Set<string>> {
  const holders = new Set<string>();
  for await (const line of pageAccountLines(client, issuer)) {
    if (currencyToString(asString(line.currency) ?? "") !== currency) continue;
    const account = asString(line.account);
    if (account) holders.add(account);
  }
  return holders;
}
