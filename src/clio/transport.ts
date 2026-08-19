import { Client } from "xrpl";

import type { ClioRawResponse, ClioRequest } from "./types.js";

/**
 * The seam between the Clio client and the network. The client depends only on
 * this interface, which keeps the governor/retry/provenance logic testable
 * without a socket and keeps xrpl.js swappable (the registrar barely uses the
 * library).
 */
export interface ClioTransport {
  readonly endpoint: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  /** Send one request. MUST reject on an upstream error response so the client
   * can classify and retry (xrpl.js's `Client.request` already does this). */
  request(req: ClioRequest): Promise<ClioRawResponse>;
}

export interface XrplTransportOptions {
  /** Connection timeout in ms, passed to xrpl.js. */
  readonly connectionTimeout?: number;
  /** Per-request timeout in ms, passed to xrpl.js as `timeout`. Generous so a
   * slow-but-valid heavy `account_tx` page is not spuriously failed. */
  readonly requestTimeout?: number;
}

/**
 * Default transport backed by xrpl.js v5 over WebSocket.
 *
 * xrpl.js v5 throws on a missing `network_id` in `server_info` and will not
 * connect without it; that check runs inside `connect()` and is a hard
 * compatibility requirement we intentionally inherit.
 */
export class XrplTransport implements ClioTransport {
  readonly endpoint: string;
  readonly #client: Client;

  constructor(endpoint: string, options: XrplTransportOptions = {}) {
    this.endpoint = endpoint;
    this.#client = new Client(endpoint, {
      ...(options.connectionTimeout !== undefined
        ? { connectionTimeout: options.connectionTimeout }
        : {}),
      ...(options.requestTimeout !== undefined ? { timeout: options.requestTimeout } : {}),
    });
  }

  async connect(): Promise<void> {
    if (!this.#client.isConnected()) await this.#client.connect();
  }

  async disconnect(): Promise<void> {
    if (this.#client.isConnected()) await this.#client.disconnect();
  }

  isConnected(): boolean {
    return this.#client.isConnected();
  }

  async request(req: ClioRequest): Promise<ClioRawResponse> {
    // xrpl.js's request typing is a large discriminated union keyed on
    // `command`; the registrar issues arbitrary Clio commands, so we cross the
    // boundary with a cast here and keep our own light types on our side.
    const response = await this.#client.request(req as unknown as Parameters<Client["request"]>[0]);
    return response as unknown as ClioRawResponse;
  }
}
