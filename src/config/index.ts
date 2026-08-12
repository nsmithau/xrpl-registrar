import { DEFAULT_GOVERNOR_OPTIONS, type GovernorOptions } from "../clio/governor.js";

export interface AppConfig {
  readonly clio: {
    /** Upstream Clio WebSocket endpoint. Must be a full-history Clio server. */
    readonly endpoint: string;
    /** Max retries per request on load signals. */
    readonly maxRetries: number;
    /** WebSocket connection timeout in ms. */
    readonly connectionTimeout: number;
  };
  readonly db: {
    /**
     * Filesystem directory for the in-process (PGlite) database. `undefined`
     * means an ephemeral in-memory database — fine for a quick start or tests,
     * but a persistent archive must set `DATABASE_DIR`.
     */
    readonly dataDir: string | undefined;
  };
  readonly governor: GovernorOptions;
}

function intFromEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Expected an integer, got: ${value}`);
  }
  return parsed;
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
      maxRetries: intFromEnv(env.CLIO_MAX_RETRIES, 5),
      connectionTimeout: intFromEnv(env.CLIO_CONNECTION_TIMEOUT_MS, 20_000),
    },
    db: {
      dataDir: env.DATABASE_DIR?.trim() || undefined,
    },
    governor: {
      maxConcurrent: intFromEnv(env.GOVERNOR_MAX_CONCURRENT, DEFAULT_GOVERNOR_OPTIONS.maxConcurrent),
      minBackoffMs: intFromEnv(env.GOVERNOR_MIN_BACKOFF_MS, DEFAULT_GOVERNOR_OPTIONS.minBackoffMs),
      maxBackoffMs: intFromEnv(env.GOVERNOR_MAX_BACKOFF_MS, DEFAULT_GOVERNOR_OPTIONS.maxBackoffMs),
      backoffFactor: intFromEnv(env.GOVERNOR_BACKOFF_FACTOR, DEFAULT_GOVERNOR_OPTIONS.backoffFactor),
    },
  };
}
