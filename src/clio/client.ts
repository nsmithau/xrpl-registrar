import { nullLogger, type Logger } from "../logging/logger.js";

import { classifyError } from "./classify.js";
import { ApiVersionError, ClioRequestError } from "./errors.js";
import { Governor } from "./governor.js";
import type { ClioTransport } from "./transport.js";
import type { ClioRawResponse, ClioRequest, ClioResponse } from "./types.js";

export interface ClioClientOptions {
  /** The single global governor shared across every issuance and worker. */
  readonly governor: Governor;
  /** The transport to talk upstream through. */
  readonly transport: ClioTransport;
  /** Max retries per request on load signals. Default 5. */
  readonly maxRetries?: number;
  readonly logger?: Logger;
  /** Provenance clock, injectable for tests. Default `() => new Date()`. */
  readonly now?: () => Date;
}

const DEFAULT_MAX_RETRIES = 5;

/**
 * The only component that talks to upstream Clio.
 *
 * Every request:
 *   1. is forced to `api_version: 2`, rejecting any other explicit value;
 *   2. passes through the global governor — the shared concurrency + backoff
 *      chokepoint that stops N issuances from becoming N× the upstream load;
 *   3. retries on load signals, letting the governor's global cooldown pace the
 *      retry (an honest, increasing, cluster-wide backoff);
 *   4. is stamped with provenance (source endpoint + fetch time) so anything
 *      bootstrapped from a given upstream stays re-verifiable later;
 *   5. carries `forwarded` and `warnings` through verbatim — reinterpreting
 *      them is the Forwarder/API layer's job, not the client's.
 */
export class ClioClient {
  readonly #governor: Governor;
  readonly #transport: ClioTransport;
  readonly #maxRetries: number;
  readonly #logger: Logger;
  readonly #now: () => Date;

  constructor(options: ClioClientOptions) {
    this.#governor = options.governor;
    this.#transport = options.transport;
    this.#maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.#logger = options.logger ?? nullLogger;
    this.#now = options.now ?? (() => new Date());
  }

  get endpoint(): string {
    return this.#transport.endpoint;
  }

  get governor(): Governor {
    return this.#governor;
  }

  async connect(): Promise<void> {
    await this.#transport.connect();
  }

  async disconnect(): Promise<void> {
    await this.#transport.disconnect();
  }

  async request<T = Record<string, unknown>>(req: ClioRequest): Promise<ClioResponse<T>> {
    const outbound = this.#prepare(req);
    let attempt = 0;

    for (;;) {
      const release = await this.#governor.acquire();
      try {
        const raw = await this.#transport.request(outbound);
        this.#governor.reward();
        return this.#wrap<T>(raw);
      } catch (err) {
        const { code, retryable } = classifyError(err);

        // A load signal on any request backs off ALL requests globally.
        if (retryable) this.#governor.penalize(this.endpoint);

        if (!retryable || attempt >= this.#maxRetries) {
          throw new ClioRequestError(
            `Clio request '${outbound.command}' failed` +
              (code !== undefined ? ` (${code})` : "") +
              (attempt > 0 ? ` after ${attempt + 1} attempts` : ""),
            { command: outbound.command, ...(code !== undefined ? { code } : {}), attempts: attempt + 1, cause: err },
          );
        }

        attempt += 1;
        this.#logger.warn("clio request retrying after load signal", {
          command: outbound.command,
          code,
          attempt,
          maxRetries: this.#maxRetries,
        });
        // If the socket dropped, actively re-establish it before retrying —
        // otherwise every subsequent request throws on the dead client and the
        // retries never recover (a wedged connection loops NotConnectedError
        // forever). connect() is a no-op when already connected.
        if (!this.#transport.isConnected()) {
          try {
            await this.#transport.connect();
          } catch (reconnectErr) {
            this.#logger.warn("clio reconnect failed; will retry after backoff", {
              error: String(reconnectErr),
            });
          }
        }
        // Fall through to the next iteration. The slot is released in `finally`
        // below, and the next `acquire()` blocks on the global cooldown the
        // penalty just set — that is the backoff.
      } finally {
        release();
      }
    }
  }

  /** Force `api_version: 2`; reject any other explicit value. */
  #prepare(req: ClioRequest): ClioRequest {
    const version = req.api_version ?? 2;
    if (version !== 2) {
      throw new ApiVersionError(
        `Only api_version 2 is supported upstream; refusing to send api_version ${version}`,
      );
    }
    return { ...req, api_version: 2 };
  }

  #wrap<T>(raw: ClioRawResponse): ClioResponse<T> {
    return {
      result: raw.result as T,
      forwarded: raw.forwarded ?? false,
      warnings: raw.warnings ?? [],
      provenance: {
        sourceEndpoint: this.endpoint,
        fetchedAt: this.#now().toISOString(),
      },
      raw,
    };
  }
}
