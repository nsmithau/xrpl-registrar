import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { WebSocketServer, type WebSocket } from "ws";

import { nullLogger, type Logger } from "../logging/logger.js";

import type { ArchiveApi } from "../api/handler.js";
import type { ApiRequest, ApiResponse } from "../api/types.js";

export interface ArchiveServerOptions {
  readonly api: ArchiveApi;
  readonly port?: number;
  readonly host?: string;
  readonly logger?: Logger;
}

function statusOf(res: ApiResponse): string {
  return typeof res.result.status === "string" ? res.result.status : "success";
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Recursively order object keys alphabetically (arrays keep their order). */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = sortKeys(source[key]);
    return out;
  }
  return value;
}

/** Serialize a response with keys sorted alphabetically at every level, so the
 * output matches Clio's ordering byte-for-byte (JSON key order is semantically
 * irrelevant, but this makes responses diff-comparable against a real Clio). */
function jsonSorted(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

/**
 * Serves the archive over the two protocols existing XRPL clients already
 * speak, so they connect by changing a URL:
 *
 *  - WebSocket: `{ id, command, api_version, ...args }` in, and
 *    `{ id, status, type, result, warnings, forwarded }` out (xrpl.js's shape).
 *  - HTTP JSON-RPC: `{ method, params: [args] }` in, `{ result }` out.
 *
 * Both funnel through the same `ArchiveApi.handle`.
 */
export class ArchiveServer {
  readonly #api: ArchiveApi;
  readonly #port: number;
  readonly #host: string;
  readonly #logger: Logger;
  readonly #http: Server;
  readonly #wss: WebSocketServer;

  constructor(options: ArchiveServerOptions) {
    this.#api = options.api;
    this.#port = options.port ?? 51234;
    this.#host = options.host ?? "127.0.0.1";
    this.#logger = options.logger ?? nullLogger;
    this.#http = createServer((req, res) => void this.#handleHttp(req, res));
    this.#wss = new WebSocketServer({ server: this.#http });
    this.#wss.on("connection", (socket) => this.#handleSocket(socket));
  }

  /** Start listening; resolves with the bound port (useful when port is 0). */
  start(): Promise<number> {
    return new Promise((resolve) => {
      this.#http.listen(this.#port, this.#host, () => {
        const address = this.#http.address() as AddressInfo;
        this.#logger.info("archive server listening", { host: this.#host, port: address.port });
        resolve(address.port);
      });
    });
  }

  async stop(): Promise<void> {
    // Drop live WebSocket and idle keep-alive connections so close() resolves
    // promptly. Without this, http.close() blocks until every client disconnects
    // — which stalls a `tsx watch` restart whenever the dashboard or a WS client
    // is connected.
    for (const ws of this.#wss.clients) ws.terminate();
    await new Promise<void>((resolve) => this.#wss.close(() => resolve()));
    this.#http.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      this.#http.close((err) => (err ? reject(err) : resolve())),
    );
  }

  #handleSocket(socket: WebSocket): void {
    socket.on("message", (data) => {
      void (async () => {
        let id: unknown;
        try {
          const msg = asObject(JSON.parse(data.toString()));
          id = msg["id"];
          const { id: _ignored, ...rest } = msg;
          const res = await this.#api.handle(rest as ApiRequest);
          socket.send(
            jsonSorted({
              ...(id !== undefined ? { id } : {}),
              type: "response",
              status: statusOf(res),
              result: res.result,
              warnings: res.warnings,
              forwarded: res.forwarded,
            }),
          );
        } catch (err) {
          this.#logger.error("ws message failed", { error: String(err) });
          socket.send(
            jsonSorted({
              ...(id !== undefined ? { id } : {}),
              type: "response",
              status: "error",
              error: "badRequest",
              error_message: "Malformed request.",
            }),
          );
        }
      })();
    });
  }

  async #handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(jsonSorted({ result: { status: "error", error: "methodNotAllowed" } }));
      return;
    }
    try {
      const body = await readBody(req);
      const parsed = asObject(JSON.parse(body));
      const method = typeof parsed["method"] === "string" ? parsed["method"] : undefined;
      const params = Array.isArray(parsed["params"]) ? asObject(parsed["params"][0]) : {};
      if (!method) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          jsonSorted({
            result: {
              status: "error",
              error: "invalidParams",
              error_message: "'method' is required",
            },
          }),
        );
        return;
      }
      const apiRes = await this.#api.handle({ command: method, ...params } as ApiRequest);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        jsonSorted({
          result: { ...apiRes.result, warnings: apiRes.warnings, forwarded: apiRes.forwarded },
        }),
      );
    } catch (err) {
      this.#logger.error("http request failed", { error: String(err) });
      res.writeHead(400, { "content-type": "application/json" });
      res.end(jsonSorted({ result: { status: "error", error: "badRequest" } }));
    }
  }
}

// Cap the buffered request body so an unbounded/huge POST cannot exhaust memory
// (this endpoint is public/unauthenticated). 1 MiB is far above any real JSON-RPC
// request. A reverse proxy should also cap it, but do not rely on that.
const MAX_BODY_BYTES = 1_000_000;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("request body too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
