/**
 * Wire and envelope types for the Clio client.
 *
 * We deliberately keep our own light request/response shapes at this boundary
 * rather than leaning on xrpl.js's heavily-overloaded types: the ingestor
 * barely uses the client library, and a thin, explicit surface keeps the
 * transport swappable and the client unit-testable without a socket.
 */

/** Provenance stamped onto everything the client returns. */
export interface Provenance {
  /** The upstream endpoint the data was fetched from. */
  readonly sourceEndpoint: string;
  /** ISO-8601 timestamp of when we fetched it. */
  readonly fetchedAt: string;
}

/**
 * A Clio/xrpld response warning. Keyed by `id`, never by `message` — callers
 * must branch on `id`/`details`, not on prose (the API docs say so explicitly).
 */
export interface ClioWarning {
  readonly id: number;
  readonly message?: string;
  readonly details?: Record<string, unknown>;
}

/** An outbound request. `command` is the WebSocket method name. */
export interface ClioRequest {
  readonly command: string;
  /**
   * Optional here only so callers may omit it; the client always sends
   * `api_version: 2` and rejects any other explicit value.
   */
  readonly api_version?: number;
  readonly [key: string]: unknown;
}

/** The raw response as it comes off the wire, before we wrap it. */
export interface ClioRawResponse {
  readonly id?: string | number;
  /** Top-level status. Note: forwarded responses ALSO nest a `status` inside
   * `result` — the two can differ and must not be conflated. We
   * pass both through untouched; resolving them is the Forwarder/API layer's
   * job, not the client's. */
  readonly status?: string;
  readonly type?: string;
  readonly result: Record<string, unknown>;
  readonly warnings?: ClioWarning[];
  /** Set by Clio when a request was proxied to a P2P node. */
  readonly forwarded?: boolean;
  readonly api_version?: number;
}

/**
 * The client's return envelope: the upstream result plus the provenance and
 * pass-through metadata every downstream component depends on. `warnings` and
 * `forwarded` are carried verbatim — the client does not reinterpret them.
 */
export interface ClioResponse<T = Record<string, unknown>> {
  readonly result: T;
  readonly forwarded: boolean;
  readonly warnings: ClioWarning[];
  readonly provenance: Provenance;
  /** The untouched raw response, for pass-through / equivalence testing. */
  readonly raw: ClioRawResponse;
}
