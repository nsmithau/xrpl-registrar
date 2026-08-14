import type { ClioWarning } from "../clio/types.js";

/**
 * Clio's own warning, emitted unchanged. Clients that branch on Clio behaviour
 * must take the same path against us, so we keep the id and message verbatim.
 */
export const CLIO_WARNING: ClioWarning = {
  id: 2001,
  message:
    "This is a clio server. clio only serves validated data. If you want to talk to rippled, include 'ledger_index':'current' in your request",
};

/**
 * Provisional warning id for "this response came from a filtered archive".
 * A registered id should be proposed to XRPLF; kept in a high range to avoid
 * colliding with allocated low ids.
 */
export const FILTERED_ARCHIVE_WARNING_ID = 65001;

/** Provisional warning id for "this response was proxied from an upstream node
 * and is NOT archive-sourced" — no completeness or provenance guarantee. */
export const FORWARDED_NOT_ARCHIVE_WARNING_ID = 65002;

/**
 * Attached to every archive response. Deliberately carries no `details`: the
 * id + message are the honest contract (absence may mean out-of-scope, not
 * non-existent). The full tracked scope is not echoed on every read — a client
 * that needs it gets it exactly where it is actionable, in the `notInArchive`
 * error returned when a request actually falls out of scope.
 */
export const FILTERED_ARCHIVE_WARNING: ClioWarning = {
  id: FILTERED_ARCHIVE_WARNING_ID,
  message:
    "This is a filtered XRPL archive: it serves only accounts in scope for its tracked issuances. Absence of data may mean out-of-scope, not non-existent.",
};

/** Provisional warning id for "the requested ledger range exceeds this
 * account's guaranteed-complete coverage". */
export const RANGE_BEYOND_COVERAGE_WARNING_ID = 65003;

export function rangeBeyondCoverageWarning(
  requested: { min?: number; max?: number },
  coverage: { fromLedger: number; toLedger: number } | null,
): ClioWarning {
  return {
    id: RANGE_BEYOND_COVERAGE_WARNING_ID,
    message:
      "The requested ledger range exceeds this account's guaranteed-complete coverage; results outside coverage may be incomplete.",
    details: { requested, coverage },
  };
}

export function forwardedNotArchiveWarning(): ClioWarning {
  return {
    id: FORWARDED_NOT_ARCHIVE_WARNING_ID,
    message:
      "This response was proxied from an upstream node and is not archive-sourced; it carries no completeness or provenance guarantee.",
  };
}

/** Warnings for a response served locally from the archive. */
export function localWarnings(): ClioWarning[] {
  return [CLIO_WARNING, FILTERED_ARCHIVE_WARNING];
}
