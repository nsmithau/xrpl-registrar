import type { ClioClient } from "../clio/client.js";
import type { ClioWarning } from "../clio/types.js";

import type { ApiRequest } from "./types.js";

export interface ForwardResult {
  readonly result: Record<string, unknown>;
  readonly warnings: ClioWarning[];
}

/**
 * Proxies a request to an upstream node. Used for node-state and submission
 * methods, and — only when explicitly enabled — for out-of-scope reads.
 */
export interface Forwarder {
  forward(req: ApiRequest): Promise<ForwardResult>;
}

/** Forwarder backed by the governed Clio client. */
export class ClioForwarder implements Forwarder {
  readonly #client: ClioClient;

  constructor(client: ClioClient) {
    this.#client = client;
  }

  async forward(req: ApiRequest): Promise<ForwardResult> {
    const res = await this.#client.request(req);
    return { result: res.result, warnings: res.warnings };
  }
}

/** A forwarder that refuses — the default when no upstream is wired. */
export class DisabledForwarder implements Forwarder {
  forward(): Promise<ForwardResult> {
    return Promise.reject(new Error("Forwarding is not enabled"));
  }
}
