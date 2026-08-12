/** Errors raised by the Clio client layer. */

export class ClioClientError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * A caller asked for something other than `api_version: 2`. The archive speaks
 * v2 only; serving a v1 shape would be exactly the plausible-wrong
 * answer this project exists to avoid.
 */
export class ApiVersionError extends ClioClientError {}

/**
 * An upstream request failed after exhausting the retry policy, or failed with
 * a non-retryable error. `code` carries the xrpld error slug when present
 * (e.g. `slowDown`, `actNotFound`) so callers can branch without string-matching.
 */
export class ClioRequestError extends ClioClientError {
  readonly command: string;
  readonly code: string | undefined;
  readonly attempts: number;

  constructor(
    message: string,
    details: { command: string; code?: string; attempts: number; cause?: unknown },
  ) {
    super(message, details.cause !== undefined ? { cause: details.cause } : undefined);
    this.command = details.command;
    this.code = details.code;
    this.attempts = details.attempts;
  }
}
