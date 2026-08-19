import type { ClioTransport } from "./transport.js";
import type { ClioRawResponse, ClioRequest, ClioWarning } from "./types.js";

export interface HttpTransportOptions {
  /** Per-request timeout in ms (aborts the fetch). Default 30s. */
  readonly requestTimeout?: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}
function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Clio transport over **HTTP JSON-RPC** (`{ method, params: [args] }`).
 *
 * Stateless: no socket to manage, so a connection pool gives real parallelism —
 * unlike the single multiplexed WebSocket, where heavy binary `account_tx`
 * pages head-of-line-block each other (ADR-015/016). Used for the paged
 * backfill/heal workload; the live subscribe tail and forwarding stay on
 * WebSocket.
 *
 * Errors are surfaced the way the WS transport surfaces them so the client's
 * `classifyError`/governor logic is identical across transports: a JSON-RPC
 * error body (HTTP 200 with `result.error`) throws `{ data: { error } }`; an
 * HTTP `429`/`5xx` throws with an `httpStatus` (classified as a load signal).
 */
export class HttpTransport implements ClioTransport {
  readonly endpoint: string;
  readonly #requestTimeout: number;

  constructor(endpoint: string, options: HttpTransportOptions = {}) {
    this.endpoint = endpoint;
    this.#requestTimeout = options.requestTimeout ?? 30_000;
  }

  // Stateless — nothing to connect. isConnected() is always true so the client's
  // reconnect path is a no-op for this transport.
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  isConnected(): boolean {
    return true;
  }

  async request(req: ClioRequest): Promise<ClioRawResponse> {
    const { command, ...params } = req;
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: command, params: [params] }),
      signal: AbortSignal.timeout(this.#requestTimeout),
    });

    // 429 / 5xx are load/availability signals — throw with the status so
    // classifyError treats them as retryable and the governor backs off.
    if (res.status === 429 || res.status >= 500) {
      const err = new Error(`Clio HTTP ${res.status}`) as Error & {
        httpStatus: number;
        retryAfter?: string;
      };
      err.httpStatus = res.status;
      const retryAfter = res.headers.get("retry-after");
      if (retryAfter) err.retryAfter = retryAfter;
      throw err;
    }
    if (!res.ok) {
      // Other non-2xx: a genuine bad request, not load — non-retryable.
      throw Object.assign(new Error(`Clio HTTP ${res.status}`), { httpStatus: res.status });
    }

    const body = asRecord(await res.json()) ?? {};
    const result = asRecord(body["result"]) ?? {};

    // A JSON-RPC-level error rides inside result (HTTP 200 with result.error /
    // status:"error"). Throw it as an xrpld-style error so classifyError decides
    // retryability the same as it does for the WS transport.
    const errCode =
      asString(result["error"]) ?? (result["status"] === "error" ? "unknown" : undefined);
    if (errCode) {
      throw Object.assign(new Error(`Clio error: ${errCode}`), { data: { error: errCode } });
    }

    const rawWarnings = Array.isArray(body["warnings"]) ? body["warnings"] : result["warnings"];
    const warnings = Array.isArray(rawWarnings) ? (rawWarnings as ClioWarning[]) : undefined;
    const forwarded =
      typeof body["forwarded"] === "boolean"
        ? body["forwarded"]
        : typeof result["forwarded"] === "boolean"
          ? (result["forwarded"] as boolean)
          : undefined;

    return {
      result,
      ...(warnings ? { warnings } : {}),
      ...(forwarded !== undefined ? { forwarded } : {}),
      ...(typeof result["status"] === "string" ? { status: result["status"] as string } : {}),
    };
  }
}
