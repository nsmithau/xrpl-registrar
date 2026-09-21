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

  describe("admin bind address and cookie", () => {
    const base = { CLIO_ENDPOINT: "wss://clio.example" };

    it("binds the admin port to loopback with a plain cookie by default", () => {
      expect(loadConfig(base).admin).toMatchObject({ host: "127.0.0.1", secureCookie: false });
    });

    it("reads ADMIN_HOST and ADMIN_SECURE_COOKIE for a container / proxied deployment", () => {
      const cfg = loadConfig({ ...base, ADMIN_HOST: "0.0.0.0", ADMIN_SECURE_COOKIE: "true" });
      expect(cfg.admin).toMatchObject({ host: "0.0.0.0", secureCookie: true });
    });

    it("rejects a malformed ADMIN_SECURE_COOKIE rather than treating it as false", () => {
      expect(() => loadConfig({ ...base, ADMIN_SECURE_COOKIE: "yes please" })).toThrow(
        /Expected a boolean/,
      );
    });
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
        ssl: true,
        applicationName: "xrpl-registrar",
      });
    });

    it("does not force TLS for a loopback URL, so sslmode / PGSSLMODE still apply", () => {
      const db = loadConfig({
        ...base,
        DATABASE_URL: "postgres://u:p@127.0.0.1:5432/archive",
      }).db;
      expect(db).toEqual({
        engine: "postgres",
        connectionString: "postgres://u:p@127.0.0.1:5432/archive",
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

    it("honours DATABASE_SSL=false against a remote host", () => {
      const db = loadConfig({
        ...base,
        DATABASE_URL: "postgres://host/archive",
        DATABASE_SSL: "false",
      }).db;
      expect(db).toMatchObject({ engine: "postgres", ssl: false });
    });

    it("rejects a non-positive pool size", () => {
      expect(() =>
        loadConfig({ ...base, DATABASE_URL: "postgres://host/archive", DATABASE_POOL_MAX: "0" }),
      ).toThrow(/positive integer/);
      expect(() =>
        loadConfig({ ...base, DATABASE_URL: "postgres://host/archive", DATABASE_POOL_MAX: "-1" }),
      ).toThrow(/positive integer/);
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

    // The container image pins STORAGE_ENGINE=postgres: its filesystem is
    // ephemeral, so silently falling back to in-process PGlite would be an
    // archive that evaporates on restart.
    describe("STORAGE_ENGINE pin", () => {
      it("accepts postgres when DATABASE_URL is set", () => {
        const db = loadConfig({
          ...base,
          STORAGE_ENGINE: "postgres",
          DATABASE_URL: "postgres://host/archive",
        }).db;
        expect(db.engine).toBe("postgres");
      });

      it("fails closed when postgres is pinned but DATABASE_URL is missing", () => {
        expect(() => loadConfig({ ...base, STORAGE_ENGINE: "postgres" })).toThrow(
          /STORAGE_ENGINE=postgres but DATABASE_URL is unset/,
        );
        // A DATABASE_DIR does not satisfy a postgres pin either.
        expect(() =>
          loadConfig({ ...base, STORAGE_ENGINE: "postgres", DATABASE_DIR: "./data" }),
        ).toThrow(/STORAGE_ENGINE=postgres but DATABASE_URL is unset/);
      });

      it("accepts pglite with or without DATABASE_DIR, but not with DATABASE_URL", () => {
        expect(loadConfig({ ...base, STORAGE_ENGINE: "pglite" }).db).toEqual({ engine: "pglite" });
        expect(loadConfig({ ...base, STORAGE_ENGINE: "PGlite", DATABASE_DIR: "./d" }).db).toEqual({
          engine: "pglite",
          dataDir: "./d",
        });
        expect(() =>
          loadConfig({ ...base, STORAGE_ENGINE: "pglite", DATABASE_URL: "postgres://host/a" }),
        ).toThrow(/STORAGE_ENGINE=pglite but DATABASE_URL is set/);
      });

      it("rejects an unknown engine name", () => {
        expect(() => loadConfig({ ...base, STORAGE_ENGINE: "sqlite" })).toThrow(
          /STORAGE_ENGINE must be 'postgres' or 'pglite'/,
        );
      });
    });
  });
});
