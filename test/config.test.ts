import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config/index.js";

describe("loadConfig", () => {
  it("requires CLIO_ENDPOINT and fails closed when it is missing", () => {
    expect(() => loadConfig({})).toThrow(/CLIO_ENDPOINT is required/);
    expect(() => loadConfig({ CLIO_ENDPOINT: "   " })).toThrow(/CLIO_ENDPOINT is required/);
  });

  it("reads the endpoint and applies governor/client defaults", () => {
    const cfg = loadConfig({ CLIO_ENDPOINT: "wss://clio.example" });
    expect(cfg.clio.endpoint).toBe("wss://clio.example");
    expect(cfg.clio.maxRetries).toBe(5);
    expect(cfg.clio.requestTimeout).toBe(30_000);
    expect(cfg.clio.httpEndpoint).toBeUndefined(); // WS-only unless CLIO_HTTP_ENDPOINT is set
    expect(cfg.governor.maxConcurrent).toBe(4);
    expect(cfg.governor.minBackoffMs).toBe(1_000);
  });

  it("overrides numeric settings from the environment", () => {
    const cfg = loadConfig({
      CLIO_ENDPOINT: "wss://clio.example",
      CLIO_MAX_RETRIES: "9",
      GOVERNOR_MAX_CONCURRENT: "2",
      GOVERNOR_MAX_BACKOFF_MS: "30000",
    });
    expect(cfg.clio.maxRetries).toBe(9);
    expect(cfg.governor.maxConcurrent).toBe(2);
    expect(cfg.governor.maxBackoffMs).toBe(30_000);
  });

  it("reads the optional HTTP JSON-RPC endpoint for backfill paging", () => {
    const cfg = loadConfig({
      CLIO_ENDPOINT: "wss://clio.example",
      CLIO_HTTP_ENDPOINT: "https://clio.example:51234/",
    });
    expect(cfg.clio.httpEndpoint).toBe("https://clio.example:51234/");
  });

  it("rejects a non-integer numeric setting", () => {
    expect(() =>
      loadConfig({ CLIO_ENDPOINT: "wss://clio.example", CLIO_MAX_RETRIES: "lots" }),
    ).toThrow(/Expected an integer/);
  });

  describe("storage engine selection", () => {
    const base = { CLIO_ENDPOINT: "wss://clio.example" };

    it("defaults to the in-process engine, ephemeral when DATABASE_DIR is unset", () => {
      expect(loadConfig(base).db).toEqual({ engine: "pglite" });
    });

    it("persists the in-process engine at DATABASE_DIR", () => {
      expect(loadConfig({ ...base, DATABASE_DIR: "./data" }).db).toEqual({
        engine: "pglite",
        dataDir: "./data",
      });
    });

    it("selects networked Postgres when DATABASE_URL is set", () => {
      const db = loadConfig({ ...base, DATABASE_URL: "postgres://u:p@host:5432/archive" }).db;
      expect(db).toEqual({
        engine: "postgres",
        connectionString: "postgres://u:p@host:5432/archive",
        ssl: false,
        applicationName: "xrpl-registrar",
      });
    });

    it("reads the optional pool size and TLS flag", () => {
      const db = loadConfig({
        ...base,
        DATABASE_URL: "postgres://host/archive",
        DATABASE_POOL_MAX: "25",
        DATABASE_SSL: "true",
      }).db;
      expect(db).toMatchObject({ engine: "postgres", max: 25, ssl: true });
    });

    // The two point at different archives, so picking one silently could look
    // like data loss to an operator who added a URL to a PGlite deployment.
    it("refuses to guess when both engines are configured", () => {
      expect(() =>
        loadConfig({ ...base, DATABASE_URL: "postgres://host/archive", DATABASE_DIR: "./data" }),
      ).toThrow(/both set/);
    });

    it("rejects a malformed boolean rather than treating it as false", () => {
      expect(() =>
        loadConfig({ ...base, DATABASE_URL: "postgres://host/archive", DATABASE_SSL: "maybe" }),
      ).toThrow(/Expected a boolean/);
    });
  });
});
