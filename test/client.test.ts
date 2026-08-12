import { describe, expect, it } from "vitest";

import { ClioClient } from "../src/clio/client.js";
import { ApiVersionError, ClioRequestError } from "../src/clio/errors.js";
import { Governor } from "../src/clio/governor.js";

import { FakeClock, FakeTransport, xrpldError, successTransport, tick } from "./helpers.js";

describe("ClioClient api_version enforcement", () => {
  it("forces api_version 2 onto every outbound request", async () => {
    const transport = successTransport();
    const client = new ClioClient({ governor: new Governor(), transport });

    await client.request({ command: "server_info" });

    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]).toMatchObject({ command: "server_info", api_version: 2 });
  });

  it("rejects an explicit non-v2 request without touching the transport", async () => {
    const transport = successTransport();
    const client = new ClioClient({ governor: new Governor(), transport });

    await expect(client.request({ command: "account_tx", api_version: 1 })).rejects.toBeInstanceOf(
      ApiVersionError,
    );
    expect(transport.calls).toHaveLength(0);
  });
});

describe("ClioClient provenance and pass-through", () => {
  it("stamps source endpoint and fetch time, passing forwarded/warnings through", async () => {
    const fetchedAt = new Date("2026-08-12T00:00:00.000Z");
    const warnings = [{ id: 2001, message: "clio server" }];
    const transport = new FakeTransport(
      () =>
        Promise.resolve({
          result: { info: { network_id: 0 } },
          status: "success",
          forwarded: true,
          warnings,
        }),
      "wss://clio.example",
    );
    const client = new ClioClient({
      governor: new Governor(),
      transport,
      now: () => fetchedAt,
    });

    const res = await client.request({ command: "server_info" });

    expect(res.provenance).toEqual({
      sourceEndpoint: "wss://clio.example",
      fetchedAt: "2026-08-12T00:00:00.000Z",
    });
    expect(res.forwarded).toBe(true);
    expect(res.warnings).toEqual(warnings); // carried verbatim, not reinterpreted
    expect(res.result).toEqual({ info: { network_id: 0 } });
  });

  it("defaults forwarded to false and warnings to an empty array", async () => {
    const client = new ClioClient({ governor: new Governor(), transport: successTransport() });
    const res = await client.request({ command: "fee" });
    expect(res.forwarded).toBe(false);
    expect(res.warnings).toEqual([]);
  });
});

describe("ClioClient retry and backoff", () => {
  it("retries on slowDown after the governor's global cooldown, then succeeds", async () => {
    const clock = new FakeClock();
    const governor = new Governor({ minBackoffMs: 1_000 }, clock);
    const transport = new FakeTransport((_req, callIndex) =>
      callIndex === 0
        ? Promise.reject(xrpldError("slowDown"))
        : Promise.resolve({ result: { ok: true }, status: "success" }),
    );
    const client = new ClioClient({ governor, transport });

    const p = client.request({ command: "account_tx" });

    await tick();
    expect(transport.calls).toHaveLength(1); // first attempt failed
    expect(governor.stats().totalPenalties).toBe(1); // global backoff engaged
    expect(governor.stats().inFlight).toBe(0); // slot released while backing off

    await clock.advance(1_000);
    const res = await p;

    expect(res.result).toEqual({ ok: true });
    expect(transport.calls).toHaveLength(2);
  });

  it("surfaces a non-retryable error immediately without penalizing", async () => {
    const governor = new Governor();
    const transport = new FakeTransport(() => Promise.reject(xrpldError("actNotFound")));
    const client = new ClioClient({ governor, transport });

    const err = await client.request({ command: "account_info" }).catch((e) => e);

    expect(err).toBeInstanceOf(ClioRequestError);
    expect(err.code).toBe("actNotFound");
    expect(err.attempts).toBe(1);
    expect(transport.calls).toHaveLength(1);
    expect(governor.stats().totalPenalties).toBe(0);
  });

  it("gives up after maxRetries and reports attempt count and code", async () => {
    const clock = new FakeClock();
    const governor = new Governor({ minBackoffMs: 100, maxBackoffMs: 100 }, clock);
    const transport = new FakeTransport(() => Promise.reject(xrpldError("slowDown")));
    const client = new ClioClient({ governor, transport, maxRetries: 2 });

    const resultPromise = client.request({ command: "account_tx" }).catch((e) => e);

    await tick();
    expect(transport.calls).toHaveLength(1);
    await clock.advance(100);
    await tick();
    expect(transport.calls).toHaveLength(2);
    await clock.advance(100);
    await tick();
    expect(transport.calls).toHaveLength(3);

    const err = await resultPromise;
    expect(err).toBeInstanceOf(ClioRequestError);
    expect(err.code).toBe("slowDown");
    expect(err.attempts).toBe(3); // initial + 2 retries
    expect(governor.stats().totalPenalties).toBe(3);
  });
});
