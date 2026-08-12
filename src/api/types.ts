import type { ClioWarning } from "../clio/types.js";

/** An inbound request to the archive's Clio-compatible API. */
export interface ApiRequest {
  readonly command: string;
  readonly api_version?: number;
  readonly [key: string]: unknown;
}

/**
 * A response in Clio's shape. `result.status` is `"success"` or `"error"`;
 * warnings are keyed by id (never matched on message text). `forwarded` marks a
 * response proxied to an upstream node rather than served from the archive.
 */
export interface ApiResponse {
  readonly result: Record<string, unknown>;
  readonly warnings: ClioWarning[];
  readonly forwarded: boolean;
}

/** One tracked issuance, summarised for the filtered-archive warning. */
export interface IssuanceSummary {
  readonly id: number;
  readonly kind: "mpt" | "iou";
  readonly mptIssuanceId?: string;
  readonly currency?: string;
  readonly issuer?: string;
}

/** The archive's scope, carried in the filtered-archive warning `details`. */
export interface ArchiveScopeSummary {
  readonly issuances: IssuanceSummary[];
  readonly coverage: { readonly min: number; readonly max: number } | null;
}

/** A method handler's output: a Clio-shaped result plus any warnings specific
 * to this response (beyond the standard archive warnings). */
export interface MethodResult {
  readonly result: Record<string, unknown>;
  readonly extraWarnings?: import("../clio/types.js").ClioWarning[];
}
