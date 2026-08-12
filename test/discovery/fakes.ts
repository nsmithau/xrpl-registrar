import type { ClioRequest, ClioResponse } from "../../src/clio/types.js";
import type { ClioReader } from "../../src/discovery/types.js";

/**
 * A fake ClioReader driven by a handler that returns the `result` payload for
 * each request. Wraps it in the ClioResponse envelope the real client returns.
 */
export function fakeReader(handle: (req: ClioRequest) => Record<string, unknown>): ClioReader {
  return {
    request: <T = Record<string, unknown>>(req: ClioRequest): Promise<ClioResponse<T>> => {
      const result = handle(req) as T;
      return Promise.resolve({
        result,
        forwarded: false,
        warnings: [],
        provenance: { sourceEndpoint: "fake", fetchedAt: "2026-01-01T00:00:00.000Z" },
        raw: { result: {} },
      });
    },
  };
}

/** Build an account_tx JSON entry. */
export function txEntry(
  ledgerIndex: number,
  txJson: Record<string, unknown>,
  affectedNodes: unknown[] = [],
): Record<string, unknown> {
  return {
    tx_json: txJson,
    ledger_index: ledgerIndex,
    meta: { AffectedNodes: affectedNodes },
  };
}

/** Build a modified MPToken affected-node for a given owner + issuance. */
export function mptTokenNode(owner: string, mptIssuanceId: string): Record<string, unknown> {
  return {
    ModifiedNode: {
      LedgerEntryType: "MPToken",
      FinalFields: { Account: owner, MPTokenIssuanceID: mptIssuanceId },
    },
  };
}
