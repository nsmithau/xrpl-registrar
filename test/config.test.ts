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

  it("rejects a non-integer numeric setting", () => {
    expect(() =>
      loadConfig({ CLIO_ENDPOINT: "wss://clio.example", CLIO_MAX_RETRIES: "lots" }),
    ).toThrow(/Expected an integer/);
  });
});
