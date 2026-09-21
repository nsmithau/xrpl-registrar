import { DEFAULT_GOVERNOR_OPTIONS, type GovernorOptions } from "../clio/governor.js";
import type { ArchiveDatabaseOptions } from "../db/index.js";

export interface AppConfig {
  readonly clio: {
    /** Upstream Clio WebSocket endpoint. Must be a full-history Clio server. */
    readonly endpoint: string;
    /** Optional Clio HTTP JSON-RPC endpoint. When set, the paged backfill/heal
     * `account_tx` workload uses it (parallelises far better than the single WS
     * socket — ADR-016); the tail and forwarding stay on the WS endpoint. When
     * unset, backfill paging falls back to the WS endpoint. */
    readonly httpEndpoint: string | undefined;
    /** Max retries per request on load signals. */
    readonly maxRetries: number;
    /** WebSocket connection timeout in ms. */
    readonly connectionTimeout: number;
    /** Per-request timeout in ms. Generous by default: a heavy `account_tx`
     * page can legitimately take several seconds (probe: multi-second p50 on
     * testnet), so a short timeout would spuriously fail slow-but-valid pages
     * and drive needless backoff/retries. */
    readonly requestTimeout: number;
  };
  /**
   * Storage engine and its settings, ready to hand to `openArchiveDatabase`.
   * Either the in-process PGlite database (the default — see `DATABASE_DIR`)
   * or a networked Postgres server (`DATABASE_URL`).
   */
  readonly db: ArchiveDatabaseOptions;
  readonly admin: {
    /** Admin port (separate from the public read port). */
    readonly port: number;
    /** Bind address for the admin port. Loopback by default; a container or a
     * LAN deployment behind the operator's own TLS proxy sets `ADMIN_HOST`
     * (ADR-019). The admin port speaks plain HTTP, so anything but loopback
     * expects a TLS-terminating proxy in front. */
    readonly host: string;
    /** Mark the dashboard session cookie `Secure`. Set `ADMIN_SECURE_COOKIE=true`
     * once the dashboard is served over HTTPS (by that proxy). */
    readonly secureCookie: boolean;
    /** Bearer token required by the admin API. Admin is disabled if unset. */
    readonly token: string | undefined;
    /** Base URL of a block explorer (e.g. `https://testnet.xrpl.org`). When set,
     * the dashboard links transaction hashes, ledgers, and MPT ids to it. */
    readonly explorerBaseUrl: string | undefined;
  };
  readonly governor: GovernorOptions;
}

function boolFromEnv(value: string | undefined, fallback: boolean): boolean {
  const v = value?.trim().toLowerCase();
  if (v === undefined || v === "") return fallback;
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;
  throw new Error(`Expected a boolean (true/false), got: ${value}`);
}

function intFromEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  // Validate the whole string: Number.parseInt("10abc")→10 and ("3.9")→3 would
  // silently accept a malformed setting, contrary to the fail-closed stance.
  const parsed = Number(value.trim());
  if (!Number.isInteger(parsed)) {
    throw new Error(`Expected an integer, got: ${value}`);
  }
  return parsed;
}

function positiveIntFromEnv(value: string, name: string): number {
  const parsed = intFromEnv(value, 0);
  if (parsed < 1) {
    throw new Error(`${name} must be a positive integer, got: ${value}`);
  }
  return parsed;
}

/** Hostname from a Postgres URI, or undefined if the URI is unparseable. */
function postgresHostname(connectionString: string): string | undefined {
  try {
    const host = new URL(connectionString).hostname;
    return host === "" ? undefined : host;
  } catch {
    return undefined;
  }
}

function isLoopbackHostname(host: string): boolean {
  const h = host.toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
}

/**
 * TLS for the Postgres engine.
 *
 * An explicit `DATABASE_SSL` always wins. When it is unset, a non-loopback host
 * defaults to TLS on (fail-closed for a credential-bearing remote connection)
 * and loopback / unparseable URIs leave `ssl` unset so the URL's `sslmode` or
 * `PGSSLMODE` can still apply. Passing `ssl: false` unconditionally would
 * disable both of those.
 */
function sslOption(env: NodeJS.ProcessEnv, connectionString: string): boolean | undefined {
  const raw = env.DATABASE_SSL?.trim();
  if (raw) return boolFromEnv(raw, false);
  const host = postgresHostname(connectionString);
  if (host !== undefined && !isLoopbackHostname(host)) return true;
  return undefined;
}

/**
 * Choose the storage engine from the environment.
 *
 * `DATABASE_URL` selects networked Postgres; otherwise the in-process PGlite
 * database is used, persisted at `DATABASE_DIR` (or ephemeral if that is unset
 * too). PGlite remains the default deliberately — a single-issuer self-hosted
 * deployment should not need a database server to stand up (ADR-010).
 *
 * Setting both is an error rather than a precedence rule. The two point at
 * different archives, so silently picking one would mean an operator who
 * added `DATABASE_URL` to an existing PGlite deployment could come back up
 * against an empty database and read it as data loss.
 */
function loadDbConfig(env: NodeJS.ProcessEnv): ArchiveDatabaseOptions {
  const url = env.DATABASE_URL?.trim() || undefined;
  const dataDir = env.DATABASE_DIR?.trim() || undefined;

  if (url && dataDir) {
    throw new Error(
      "DATABASE_URL and DATABASE_DIR are both set; they select different storage engines. " +
        "Set DATABASE_URL for a networked Postgres server, or DATABASE_DIR for the in-process database.",
    );
  }

  // Optional pin. A deployment that must never fall back to the in-process
  // engine — the container image, whose filesystem is ephemeral — declares the
  // engine it expects, so a missing DATABASE_URL is a startup error rather than
  // an in-memory archive that evaporates on restart.
  const pinned = env.STORAGE_ENGINE?.trim().toLowerCase() || undefined;
  if (pinned !== undefined && pinned !== "postgres" && pinned !== "pglite") {
    throw new Error(`STORAGE_ENGINE must be 'postgres' or 'pglite', got: ${env.STORAGE_ENGINE}`);
  }
  if (pinned === "postgres" && !url) {
    throw new Error(
      "STORAGE_ENGINE=postgres but DATABASE_URL is unset; this deployment requires a networked Postgres server.",
    );
  }
  if (pinned === "pglite" && url) {
    throw new Error(
      "STORAGE_ENGINE=pglite but DATABASE_URL is set; unset one of them (they select different storage engines).",
    );
  }

  // Spread rather than `dataDir: undefined`: under exactOptionalPropertyTypes
  // an absent optional property and one explicitly set to undefined differ.
  if (!url) return { engine: "pglite", ...(dataDir ? { dataDir } : {}) };

  const poolMax = env.DATABASE_POOL_MAX?.trim();
  const ssl = sslOption(env, url);
  return {
    engine: "postgres",
    connectionString: url,
    applicationName: "xrpl-registrar",
    ...(ssl !== undefined ? { ssl } : {}),
    ...(poolMax ? { max: positiveIntFromEnv(poolMax, "DATABASE_POOL_MAX") } : {}),
  };
}

/**
 * Build config from the environment.
 *
 * The upstream endpoint has no default: `CLIO_ENDPOINT` is required and must
 * point at a full-history Clio server. Failing loudly when it is unset is in
 * keeping with the project's fail-closed stance — a wrong or missing source is
 * an error, never a silent fallback.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const endpoint = env.CLIO_ENDPOINT?.trim();
  if (!endpoint) {
    throw new Error("CLIO_ENDPOINT is required (a full-history Clio WebSocket URL)");
  }

  return {
    clio: {
      endpoint,
      httpEndpoint: env.CLIO_HTTP_ENDPOINT?.trim() || undefined,
      maxRetries: intFromEnv(env.CLIO_MAX_RETRIES, 5),
      connectionTimeout: intFromEnv(env.CLIO_CONNECTION_TIMEOUT_MS, 20_000),
      requestTimeout: intFromEnv(env.CLIO_REQUEST_TIMEOUT_MS, 30_000),
    },
    db: loadDbConfig(env),
    admin: {
      port: intFromEnv(env.ADMIN_PORT, 51235),
      host: env.ADMIN_HOST?.trim() || "127.0.0.1",
      secureCookie: boolFromEnv(env.ADMIN_SECURE_COOKIE, false),
      token: env.ADMIN_TOKEN?.trim() || undefined,
      explorerBaseUrl: env.EXPLORER_BASE_URL?.trim().replace(/\/+$/, "") || undefined,
    },
    governor: {
      maxConcurrent: intFromEnv(
        env.GOVERNOR_MAX_CONCURRENT,
        DEFAULT_GOVERNOR_OPTIONS.maxConcurrent,
      ),
      minBackoffMs: intFromEnv(env.GOVERNOR_MIN_BACKOFF_MS, DEFAULT_GOVERNOR_OPTIONS.minBackoffMs),
      maxBackoffMs: intFromEnv(env.GOVERNOR_MAX_BACKOFF_MS, DEFAULT_GOVERNOR_OPTIONS.maxBackoffMs),
      backoffFactor: intFromEnv(
        env.GOVERNOR_BACKOFF_FACTOR,
        DEFAULT_GOVERNOR_OPTIONS.backoffFactor,
      ),
    },
  };
}
