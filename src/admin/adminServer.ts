import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { IssuanceRecord } from "../db/repositories/issuances.js";
import { nullLogger, type Logger } from "../logging/logger.js";

import type { AdminApi, RegisterIssuance } from "./adminApi.js";
import { DASHBOARD_HTML } from "./dashboard.js";

export interface AdminServerOptions {
  readonly api: AdminApi;
  /** Bearer token required on every request. Must be non-empty. */
  readonly token: string;
  readonly port?: number;
  readonly host?: string;
  /** Called after a successful registration — wire background ingestion here. */
  readonly onRegistered?: (issuance: IssuanceRecord) => void;
  readonly logger?: Logger;
}

function tokensMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * The authenticated admin API over HTTP, on a port separate from the public
 * read API. Every request requires `Authorization: Bearer <token>`.
 * Surfaces account addresses and archive scope, so it must never be publicly
 * exposed.
 */
export class AdminServer {
  readonly #api: AdminApi;
  readonly #token: string;
  readonly #port: number;
  readonly #host: string;
  readonly #onRegistered: ((issuance: IssuanceRecord) => void) | undefined;
  readonly #logger: Logger;
  readonly #http: Server;

  constructor(options: AdminServerOptions) {
    if (!options.token) throw new Error("AdminServer requires a non-empty token");
    this.#api = options.api;
    this.#token = options.token;
    this.#port = options.port ?? 51235;
    this.#host = options.host ?? "127.0.0.1";
    this.#onRegistered = options.onRegistered;
    this.#logger = options.logger ?? nullLogger;
    this.#http = createServer((req, res) => void this.#handle(req, res));
  }

  start(): Promise<number> {
    return new Promise((resolve) => {
      this.#http.listen(this.#port, this.#host, () => {
        resolve((this.#http.address() as AddressInfo).port);
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) =>
      this.#http.close((err) => (err ? reject(err) : resolve())),
    );
  }

  #authorized(req: IncomingMessage): boolean {
    const header = req.headers.authorization ?? "";
    const prefix = "Bearer ";
    return header.startsWith(prefix) && tokensMatch(header.slice(prefix.length), this.#token);
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const pathname = url.pathname.replace(/\/+$/, "") || "/";

      // The read-only dashboard shell is static and carries no data, so it is
      // served without auth; it prompts for the token and calls the (authed)
      // JSON endpoints below.
      if (req.method === "GET" && (pathname === "/" || pathname === "/dashboard")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(DASHBOARD_HTML);
        return;
      }

      if (!this.#authorized(req)) return send(res, 401, { error: "unauthorized" });

      const parts = pathname.split("/").filter(Boolean); // e.g. ["admin","issuances","1"]
      if (parts[0] !== "admin" || parts[1] !== "issuances") {
        return send(res, 404, { error: "notFound" });
      }
      const id = parts[2] !== undefined ? Number(parts[2]) : undefined;

      if (req.method === "GET" && id === undefined) {
        return send(res, 200, { issuances: await this.#api.listIssuances() });
      }
      if (req.method === "GET" && id !== undefined) {
        const status = await this.#api.getIssuance(id);
        return status ? send(res, 200, status) : send(res, 404, { error: "notFound" });
      }
      if (req.method === "POST" && id === undefined) {
        const body = await readJson(req);
        const issuance = await this.#api.registerIssuance(body as RegisterIssuance);
        this.#onRegistered?.(issuance);
        return send(res, 201, { issuance });
      }
      if (req.method === "PATCH" && id !== undefined) {
        const body = (await readJson(req)) as { enabled?: unknown };
        if (typeof body.enabled !== "boolean") {
          return send(res, 400, { error: "invalidParams", message: "'enabled' boolean required" });
        }
        const ok = await this.#api.setEnabled(id, body.enabled);
        return ok ? send(res, 200, { id, enabled: body.enabled }) : send(res, 404, { error: "notFound" });
      }
      return send(res, 405, { error: "methodNotAllowed" });
    } catch (err) {
      this.#logger.error("admin request failed", { error: String(err) });
      send(res, 400, { error: "badRequest", message: String(err instanceof Error ? err.message : err) });
    }
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(text ? JSON.parse(text) : {});
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    req.on("error", reject);
  });
}
