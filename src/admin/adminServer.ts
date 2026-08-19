import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { IssuanceRecord } from "../db/repositories/issuances.js";
import { nullLogger, type Logger } from "../logging/logger.js";

import { AdminInputError, type AdminApi, type RegisterIssuance } from "./adminApi.js";
import { DASHBOARD_HTML } from "./dashboard.js";

export interface AdminServerOptions {
  readonly api: AdminApi;
  /** Bearer token required on every request. Must be non-empty. */
  readonly token: string;
  readonly port?: number;
  readonly host?: string;
  /** Called after a successful registration — wire background ingestion here. */
  readonly onRegistered?: (issuance: IssuanceRecord) => void;
  /** Dashboard session lifetime in ms (login cookie). Default 12h. */
  readonly sessionTtlMs?: number;
  /** Add `Secure` to the session cookie — set true when terminating TLS in
   * front. Default false (the server binds localhost over plain HTTP). */
  readonly secureCookie?: boolean;
  /** Block-explorer base URL (e.g. `https://testnet.xrpl.org`); surfaced to the
   * dashboard so it can link hashes, ledgers, and MPT ids. */
  readonly explorerBaseUrl?: string;
  readonly logger?: Logger;
}

const SESSION_COOKIE = "adm_session";

function tokensMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
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
  readonly #sessionTtlMs: number;
  readonly #secureCookie: boolean;
  readonly #explorerBaseUrl: string | undefined;
  /** Live dashboard sessions: opaque id -> expiry epoch ms. In-memory, so a
   * restart signs everyone out — fine for an operator dashboard. */
  readonly #sessions = new Map<string, number>();

  constructor(options: AdminServerOptions) {
    if (!options.token) throw new Error("AdminServer requires a non-empty token");
    this.#api = options.api;
    this.#token = options.token;
    this.#port = options.port ?? 51235;
    this.#host = options.host ?? "127.0.0.1";
    this.#onRegistered = options.onRegistered;
    this.#sessionTtlMs = options.sessionTtlMs ?? 12 * 60 * 60 * 1000;
    this.#secureCookie = options.secureCookie ?? false;
    this.#explorerBaseUrl = options.explorerBaseUrl;
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

  /** A request is authorized by EITHER a bearer token (API clients: curl,
   * Postman, xrpl.js) OR a valid dashboard session cookie (the browser, which
   * exchanged the token for the cookie at /admin/login and never holds it in
   * JS-readable storage). */
  #authorized(req: IncomingMessage): boolean {
    return this.#bearerOk(req) || this.#sessionOk(req);
  }

  #bearerOk(req: IncomingMessage): boolean {
    const header = req.headers.authorization ?? "";
    const prefix = "Bearer ";
    return header.startsWith(prefix) && tokensMatch(header.slice(prefix.length), this.#token);
  }

  #sessionOk(req: IncomingMessage): boolean {
    const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!sid) return false;
    const expiry = this.#sessions.get(sid);
    if (expiry === undefined) return false;
    if (expiry <= Date.now()) {
      this.#sessions.delete(sid); // lazy expiry sweep
      return false;
    }
    return true;
  }

  /** Exchange the admin token (JSON body or bearer header) for an httpOnly,
   * SameSite=Strict session cookie. This is the auth boundary, so it needs no
   * prior auth; a wrong token is a 401. */
  async #login(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await readJson(req)) as { token?: unknown };
    const bearer = (req.headers.authorization ?? "").startsWith("Bearer ")
      ? (req.headers.authorization ?? "").slice("Bearer ".length)
      : "";
    const provided = typeof body.token === "string" && body.token ? body.token : bearer;
    if (!provided || !tokensMatch(provided, this.#token)) {
      return send(res, 401, { error: "unauthorized" });
    }
    const sid = randomBytes(32).toString("hex");
    this.#sessions.set(sid, Date.now() + this.#sessionTtlMs);
    const attrs = [
      `${SESSION_COOKIE}=${sid}`,
      "HttpOnly",
      "SameSite=Strict",
      "Path=/",
      `Max-Age=${Math.floor(this.#sessionTtlMs / 1000)}`,
    ];
    if (this.#secureCookie) attrs.push("Secure");
    res.writeHead(200, { "content-type": "application/json", "set-cookie": attrs.join("; ") });
    res.end(JSON.stringify({ ok: true }));
  }

  /** End the current session and clear the cookie. */
  #logout(req: IncomingMessage, res: ServerResponse): void {
    const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (sid) this.#sessions.delete(sid);
    res.writeHead(200, {
      "content-type": "application/json",
      "set-cookie": `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
    });
    res.end(JSON.stringify({ ok: true }));
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

      // Session endpoints are the auth boundary itself, so they precede the gate.
      if (req.method === "POST" && pathname === "/admin/login") return this.#login(req, res);
      if (req.method === "POST" && pathname === "/admin/logout") return this.#logout(req, res);

      if (!this.#authorized(req)) return send(res, 401, { error: "unauthorized" });

      const parts = pathname.split("/").filter(Boolean); // e.g. ["admin","issuances","1"]
      if (parts[0] !== "admin" || parts[1] !== "issuances") {
        return send(res, 404, { error: "notFound" });
      }
      const id = parts[2] !== undefined ? Number(parts[2]) : undefined;

      if (req.method === "GET" && id === undefined) {
        return send(res, 200, {
          issuances: await this.#api.listIssuances(),
          latestLedger: await this.#api.latestLedgerSeen(),
          recentTransactions: await this.#api.recentTransactions(5),
          activity: this.#api.activitySnapshot(),
          backfillProgress: await this.#api.backfillProgress(),
          explorerBaseUrl: this.#explorerBaseUrl ?? null,
        });
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
        return ok
          ? send(res, 200, { id, enabled: body.enabled })
          : send(res, 404, { error: "notFound" });
      }
      return send(res, 405, { error: "methodNotAllowed" });
    } catch (err) {
      // Surface the message only for tagged caller-input errors (e.g. a malformed
      // currency); for anything else return a generic message so internal error
      // text (DB, filesystem, stack) is not disclosed to the caller.
      this.#logger.error("admin request failed", { error: String(err) });
      if (err instanceof AdminInputError) {
        send(res, 400, { error: "invalidParams", message: err.message });
      } else {
        send(res, 400, { error: "badRequest" });
      }
    }
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

// Cap the buffered body. /admin/login runs before auth, so an unbounded POST
// here would be an unauthenticated memory-exhaustion vector even on the
// loopback-bound admin port. 1 MiB dwarfs any real admin request.
const MAX_BODY_BYTES = 1_000_000;

function readJson(req: IncomingMessage): Promise<unknown> {
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
