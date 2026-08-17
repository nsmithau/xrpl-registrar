import type { ClioRequest, ClioResponse } from "../clio/types.js";

/** The strategies for deriving an issuance's historical account set. */
export type DiscoveryStrategyName = "authorization" | "trustline" | "traversal";

/** How an account came to be tracked: a bulk discovery strategy, the issuer
 * account_tx sweep that backfills every holder at once, or the live tail
 * spotting a holder in a streamed transaction. */
export type DiscoverySource = DiscoveryStrategyName | "issuer_sweep" | "stream";

/** What discovery is asked to derive the account set for. */
export type DiscoveryTarget =
  | {
      readonly kind: "mpt";
      readonly mptIssuanceId: string;
      /** Detected from issuance flags; null means "not yet known". */
      readonly requiresAuth?: boolean | null;
      /** Explicit override; otherwise the strategy is auto-selected. */
      readonly strategy?: DiscoveryStrategyName | "auto";
    }
  | {
      readonly kind: "iou";
      readonly currency: string;
      readonly issuer: string;
      readonly strategy?: DiscoveryStrategyName | "auto";
    };

export interface DiscoveredAccount {
  readonly address: string;
  readonly discoveredVia: DiscoverySource;
  /** Ledger at which the account first appears in scope, if known. */
  readonly firstAcquisitionLedger: number | null;
}

/**
 * A cross-check of the discovered set against an independent current-state
 * query. Agreement is a correctness signal; `missingFromHistorical` should be
 * empty — a current holder absent from the historical set is a defect signal.
 */
export interface DiscoveryCrossCheck {
  readonly method: "account_lines";
  readonly currentCount: number;
  readonly missingFromHistorical: string[];
}

export interface DiscoveryResult {
  readonly strategy: DiscoveryStrategyName;
  readonly accounts: DiscoveredAccount[];
  readonly crossCheck?: DiscoveryCrossCheck;
}

/**
 * The upstream capability discovery needs: a governed request method. The Clio
 * client satisfies this structurally; tests supply a fake.
 */
export interface ClioReader {
  request<T = Record<string, unknown>>(req: ClioRequest): Promise<ClioResponse<T>>;
}

/** One `account_tx` entry in the api_version 2 (JSON) shape. */
export interface AccountTxEntry {
  readonly tx_json?: Record<string, unknown>;
  readonly meta?: { AffectedNodes?: unknown[] } | undefined;
  readonly hash?: string;
  readonly ledger_index?: number;
}
