import type { Provenance } from "../clio/types.js";
import type { ClioReader } from "../discovery/types.js";

/** A binary `account_tx` entry: raw blobs plus its ledger. */
export interface BinaryTxEntry {
  readonly tx_blob: string;
  readonly meta_blob: string;
  readonly ledger_index: number;
}

export interface BackfillPage {
  readonly entries: BinaryTxEntry[];
  /** Cursor for the next page, or undefined when the account is exhausted. */
  readonly marker: unknown;
  readonly provenance: Provenance;
}

export interface AccountTxPageQuery {
  readonly account: string;
  /** Lower ledger bound — this is what makes backfill *bounded* (start from the
   * issuance/first-activity ledger rather than genesis). */
  readonly fromLedger?: number | undefined;
  readonly toLedger?: number | undefined;
  /** Resume cursor from a prior checkpoint. */
  readonly startMarker?: unknown;
  readonly limit?: number | undefined;
}

/**
 * Iterate an account's transactions as pages of raw binary, forward, bounded by
 * an optional ledger range and resumable from a prior marker. Yields each page
 * (including the final, marker-less one) so the caller can persist and
 * checkpoint per page. Every request goes through the governed client.
 */
export async function* accountTxPages(
  client: ClioReader,
  query: AccountTxPageQuery,
): AsyncGenerator<BackfillPage> {
  let marker: unknown = query.startMarker;
  for (;;) {
    const req = {
      command: "account_tx",
      account: query.account,
      forward: true,
      binary: true,
      ...(query.fromLedger !== undefined ? { ledger_index_min: query.fromLedger } : {}),
      ...(query.toLedger !== undefined ? { ledger_index_max: query.toLedger } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
      ...(marker !== undefined && marker !== null ? { marker } : {}),
    };
    const res = await client.request<{ transactions?: BinaryTxEntry[]; marker?: unknown }>(req);
    yield {
      entries: res.result.transactions ?? [],
      marker: res.result.marker,
      provenance: res.provenance,
    };
    if (res.result.marker === undefined) return;
    marker = res.result.marker;
  }
}
