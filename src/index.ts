/**
 * xrpl-registrar — public entry point.
 *
 * Implemented so far: the Clio client and its global concurrency governor —
 * the single upstream chokepoint every other component will be built on top of
 * (Discovery, Backfill, Live tail, Reconciler, Forwarder).
 */

import { ClioClient } from "./clio/client.js";
import { Governor } from "./clio/governor.js";
import { HttpTransport } from "./clio/httpTransport.js";
import { XrplTransport } from "./clio/transport.js";
import { loadConfig, type AppConfig } from "./config/index.js";
import { consoleLogger, type Logger } from "./logging/logger.js";

export * from "./clio/index.js";
export * from "./db/index.js";
export * from "./discovery/index.js";
export * from "./backfill/index.js";
export * from "./livetail/index.js";
export * from "./api/index.js";
export * from "./server/index.js";
export * from "./reconcile/index.js";
export * from "./admin/index.js";
export { decodeMptIssuer, mptSequence } from "./xrpl/mpt.js";
export { currencyToString, normalizeCurrency } from "./xrpl/currency.js";
export { loadConfig, type AppConfig } from "./config/index.js";
export { consoleLogger, nullLogger, type Logger } from "./logging/logger.js";

/**
 * Build a Clio client from config, wiring in one shared governor. A single
 * governor instance is the whole point — construct one here and hand it to
 * every consumer rather than letting components make their own.
 */
/**
 * Build the upstream client(s) and their shared governor.
 *
 * `client` is the WebSocket client — used for the live subscribe tail, node-state
 * forwarding, and everything low-volume. `pagingClient` is what the heavy paged
 * `account_tx` backfill/heal workload should use: an HTTP JSON-RPC client when
 * `CLIO_HTTP_ENDPOINT` is set (parallelises far better than one WS socket —
 * ADR-016), otherwise it falls back to the WS `client`. Both share one governor,
 * so the global concurrency cap and backoff still hold across transports.
 */
export function createClioClient(
  config: AppConfig = loadConfig(),
  logger: Logger = consoleLogger,
): { client: ClioClient; pagingClient: ClioClient; governor: Governor } {
  const governor = new Governor(config.governor);
  const transport = new XrplTransport(config.clio.endpoint, {
    connectionTimeout: config.clio.connectionTimeout,
    requestTimeout: config.clio.requestTimeout,
  });
  const client = new ClioClient({
    governor,
    transport,
    maxRetries: config.clio.maxRetries,
    logger,
  });

  let pagingClient = client;
  if (config.clio.httpEndpoint) {
    const httpTransport = new HttpTransport(config.clio.httpEndpoint, {
      requestTimeout: config.clio.requestTimeout,
    });
    pagingClient = new ClioClient({
      governor,
      transport: httpTransport,
      maxRetries: config.clio.maxRetries,
      logger,
    });
  }

  return { client, pagingClient, governor };
}
