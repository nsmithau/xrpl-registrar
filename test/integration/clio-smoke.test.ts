import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ApiVersionError, createClioClient, loadConfig } from "../../src/index.js";

/**
 * Live smoke test for the Clio client against a real upstream.
 *
 * This is the cheapest way to validate the assumptions the rest of the design
 * leans on before we build storage/discovery/backfill on top of the client:
 *
 *   - we can actually connect, and `server_info` carries `network_id`
 *     (xrpl.js v5 refuses to connect without it);
 *   - provenance is stamped correctly (source endpoint + ISO fetch time);
 *   - the upstream really is full-history (its range starts near genesis);
 *   - `ledger_index: "current"` is FORWARDED even for a method that answers
 *     locally otherwise, and forwarded responses carry a nested `status`;
 *   - Clio's warning id 2001 is passed through verbatim, keyed by id;
 *   - `api_version` enforcement holds in the live wiring.
 *
 * It is NOT part of the default `pnpm test` run (offline/CI must stay green):
 * it lives under test/integration/ and runs only via `pnpm test:integration`.
 * Even then it skips unless CLIO_ENDPOINT points at a full-history Clio server.
 *
 * Run it with, e.g.:
 *   CLIO_ENDPOINT=wss://your-full-history-clio pnpm test:integration
 */

const ENDPOINT = process.env.CLIO_ENDPOINT?.trim();
const LIVE = Boolean(ENDPOINT);

if (!LIVE) {
  console.info("[clio-smoke] skipped — set CLIO_ENDPOINT to a full-history Clio to run.");
}

/** Earliest ledger in a `complete_ledgers` string like "32570-106232907" or a
 * comma-separated list of ranges. */
function earliestLedger(completeLedgers: string): number {
  const firstRange = completeLedgers.split(",")[0]!.trim();
  return Number(firstRange.split("-")[0]);
}

// The earliest surviving XRPL ledger; a full-history Clio is contiguous from here.
const GENESIS_ERA_LEDGER = 32570;

describe.skipIf(!LIVE)("Clio client live smoke test", () => {
  let ctx!: ReturnType<typeof createClioClient>;

  beforeAll(async () => {
    ctx = createClioClient(loadConfig());
    await ctx.client.connect();
  });

  afterAll(async () => {
    await ctx?.client.disconnect();
  });

  it("connects and returns server_info with network_id and stamped provenance", async () => {
    const res = await ctx.client.request({ command: "server_info" });

    expect(res.forwarded).toBe(false);
    const info = res.result.info as Record<string, unknown>;
    expect(info).toBeTypeOf("object");
    // network_id is mandatory in our world (xrpl.js v5 requires it to connect).
    expect(info.network_id).toBeTypeOf("number");

    expect(res.provenance.sourceEndpoint).toBe(ENDPOINT);
    // fetchedAt must be a valid, round-trippable ISO timestamp.
    expect(new Date(res.provenance.fetchedAt).toISOString()).toBe(res.provenance.fetchedAt);
  });

  it("is backed by a full-history Clio (range starts near genesis)", async () => {
    const res = await ctx.client.request({ command: "server_info" });
    const info = res.result.info as Record<string, unknown>;
    const completeLedgers = info.complete_ledgers as string;

    expect(completeLedgers).toBeTypeOf("string");
    // A full-history Clio is contiguous from the earliest surviving ledger.
    // A short-window node would start in the tens of millions — that is exactly
    // the misconfiguration this assertion is here to catch.
    expect(earliestLedger(completeLedgers)).toBeLessThanOrEqual(GENESIS_ERA_LEDGER);
  });

  it("forwards ledger_index: current and marks the response forwarded", async () => {
    const local = await ctx.client.request({ command: "server_info" });
    expect(local.forwarded).toBe(false);

    const forwarded = await ctx.client.request({
      command: "server_info",
      ledger_index: "current",
    });

    // Clio proxies `current` to a P2P node regardless of whether the method
    // otherwise answers locally — the forwarding layer sits in front of the
    // method handlers.
    expect(forwarded.forwarded).toBe(true);
    // Forwarded responses nest the upstream status inside `result` alongside
    // the top-level one; assert the nested status is present.
    expect("status" in forwarded.raw.result).toBe(true);
  });

  it("passes Clio's warning id 2001 through verbatim, keyed by id", async () => {
    const res = await ctx.client.request({ command: "server_info" });

    expect(Array.isArray(res.warnings)).toBe(true);
    // Clio attaches warning id 2001 ("this is a clio server..."). We carry it
    // through unchanged and callers key on `id`, never on the message text.
    expect(res.warnings.map((w) => w.id)).toContain(2001);
  });

  it("answers a second node-state method (fee) and releases the slot", async () => {
    const res = await ctx.client.request({ command: "fee" });
    expect(res.result).toBeTypeOf("object");
    // No request should be left holding a concurrency slot once it resolves.
    expect(ctx.governor.stats().inFlight).toBe(0);
  });

  it("rejects a non-v2 request in the live wiring before dispatch", async () => {
    await expect(
      ctx.client.request({ command: "server_info", api_version: 1 }),
    ).rejects.toBeInstanceOf(ApiVersionError);
  });
});
