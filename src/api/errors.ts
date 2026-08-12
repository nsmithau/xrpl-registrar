import type { ArchiveScopeSummary } from "./types.js";

/**
 * Build a Clio-shaped error result. The archive never returns a plausible empty
 * answer; every failure is an explicit, typed error.
 */
export function errorResult(
  error: string,
  message: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { status: "error", error, error_message: message, ...extra };
}

/**
 * The account/hash is not in this archive. Deliberately distinct from
 * `actNotFound`/`txnNotFound`, which assert non-existence on the ledger — a
 * different and false claim. Carries the archive scope so callers can see why.
 */
export function notInArchive(
  what: string,
  scope: ArchiveScopeSummary,
): Record<string, unknown> {
  return errorResult(
    "notInArchive",
    `${what} is not in this filtered archive (it may exist on the ledger, out of scope).`,
    { details: { scope } },
  );
}

/** `api_version` was omitted or not 2. The protocol default is v1, so serving
 * a v2 shape to a v1 client would be a silent wrong answer. */
export function invalidApiVersion(got: number | undefined): Record<string, unknown> {
  return errorResult(
    "invalidApiVersion",
    `api_version 2 is required (got ${got === undefined ? "none" : got}).`,
  );
}

export function invalidParams(message: string): Record<string, unknown> {
  return errorResult("invalidParams", message);
}

/** A method the archive does not serve. Never a silent empty answer. */
export function unsupported(command: string): Record<string, unknown> {
  return errorResult("unsupported", `Method '${command}' is not supported by this archive.`);
}
