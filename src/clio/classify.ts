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

/**
 * Transport failures that surface as a plain `Error` (no class name, no xrpld
 * slug) — e.g. xrpl.js throwing while the socket is mid-reconnect. A disconnect
 * often produces a typed error on the first throw and a bare one on the next, so
 * recognising these by message keeps a retry from giving up mid-reconnection.
 */
const CONNECTION_ERROR_PATTERN =
  /disconnect|not connected|connection (?:closed|reset|refused|lost|error)|socket hang up|websocket|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|timed?[- ]?out/i;

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

  // HTTP JSON-RPC transport surfaces status-coded failures: 429 (rate limited)
  // and 5xx (overloaded/unavailable) are load signals; other statuses are not.
  const httpStatus = record["httpStatus"];
  if (typeof httpStatus === "number") {
    return { code: `HTTP_${httpStatus}`, retryable: httpStatus === 429 || httpStatus >= 500 };
  }

  // Connection / transport level failures, identified by class name.
  const name = readString(record, "name");
  if (name !== undefined && CONNECTION_ERROR_NAMES.has(name)) {
    return { code: name, retryable: true };
  }

  // …or by message, for transport errors that arrive as a bare `Error` (no
  // recognised class name and no xrpld slug) during a reconnection window.
  const message = readString(record, "message");
  if (message !== undefined && CONNECTION_ERROR_PATTERN.test(message)) {
    return { code: name ?? "ConnectionError", retryable: true };
  }

  return { code: name, retryable: false };
}
