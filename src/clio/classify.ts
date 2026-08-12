/**
 * Classify an error thrown by the transport into: is this a *load signal* from
 * upstream, and what is its code?
 *
 * A load signal is anything that says "the cluster is shedding load": an
 * explicit `slowDown`/`tooBusy` xrpld error, or a connection drop/timeout
 * under pressure (a busy Clio/xrpld cluster disconnects clients to shed load).
 * All of these trigger the global backoff and a retry.
 *
 * Everything else — `actNotFound`, `invalidParams`, an unknown command — is a
 * genuine answer about the request, not about load. Those are non-retryable:
 * we surface them immediately rather than hammering upstream.
 */

/** xrpld error slugs that mean "back off", not "wrong request". */
const LOAD_ERROR_CODES = new Set<string>([
  "slowDown",
  "tooBusy",
  "noNetwork",
  "noCurrent",
  "noClosed",
  "amendmentBlocked",
]);

/** xrpl.js error class names that indicate a transport-level load/availability
 * problem rather than a bad request. */
const CONNECTION_ERROR_NAMES = new Set<string>([
  "DisconnectedError",
  "NotConnectedError",
  "ConnectionError",
  "TimeoutError",
  "ResponseFormatError",
]);

export interface ErrorClassification {
  /** The xrpld error slug, or a synthetic code for connection failures. */
  readonly code: string | undefined;
  /** Whether the governor should back off and the request should be retried. */
  readonly retryable: boolean;
}

function readString(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === "string" ? value : undefined;
}

export function classifyError(err: unknown): ErrorClassification {
  if (typeof err !== "object" || err === null) {
    return { code: undefined, retryable: false };
  }

  const record = err as Record<string, unknown>;

  // xrpld error responses surface via xrpl.js as `err.data.error`.
  const data = record["data"];
  if (typeof data === "object" && data !== null) {
    const code = readString(data as Record<string, unknown>, "error");
    if (code !== undefined) {
      return { code, retryable: LOAD_ERROR_CODES.has(code) };
    }
  }

  // Some xrpl.js errors put the slug directly on the error.
  const directCode = readString(record, "error");
  if (directCode !== undefined) {
    return { code: directCode, retryable: LOAD_ERROR_CODES.has(directCode) };
  }

  // Connection / transport level failures, identified by class name.
  const name = readString(record, "name");
  if (name !== undefined && CONNECTION_ERROR_NAMES.has(name)) {
    return { code: name, retryable: true };
  }

  return { code: name, retryable: false };
}
