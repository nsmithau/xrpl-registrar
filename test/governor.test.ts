import { describe, expect, it } from "vitest";

import { Governor, type RateLimitEvent } from "../src/clio/governor.js";

import { FakeClock, tick } from "./helpers.js";

describe("Governor concurrency", () => {
  it("caps in-flight acquisitions at maxConcurrent and queues the rest", async () => {
    const g = new Governor({ maxConcurrent: 2 });

    const r1 = await g.acquire();
    const r2 = await g.acquire();
    expect(g.stats().inFlight).toBe(2);

    let thirdAcquired = false;
    const p3 = g.acquire().then((release) => {
      thirdAcquired = true;
      return release;
    });

    await tick();
    expect(thirdAcquired).toBe(false);
    expect(g.stats().queued).toBe(1);

    // Releasing a slot hands it to the queued waiter without dropping the count.
    r1();
    const r3 = await p3;
    expect(thirdAcquired).toBe(true);
    expect(g.stats().inFlight).toBe(2);
    expect(g.stats().queued).toBe(0);

    r2();
    r3();
    expect(g.stats().inFlight).toBe(0);
  });

  it("rejects a maxConcurrent below 1", () => {
    expect(() => new Governor({ maxConcurrent: 0 })).toThrow(RangeError);
  });
});

describe("Governor global backoff", () => {
  it("escalates exponentially and caps at maxBackoffMs", () => {
    const clock = new FakeClock();
    const g = new Governor(
      { minBackoffMs: 1_000, maxBackoffMs: 8_000, backoffFactor: 2 },
      clock,
    );

    const steps = [1_000, 2_000, 4_000, 8_000, 8_000];
    for (const expected of steps) {
      g.penalize("wss://clio.example");
      expect(g.stats().currentBackoffMs).toBe(expected);
    }

    expect(g.stats().totalPenalties).toBe(5);
    expect(g.stats().consecutivePenalties).toBe(5);
    // Cooldown is set from the last (capped) penalty: now(0) + 8000.
    expect(g.stats().cooldownUntil).toBe(8_000);
  });

  it("holds all acquisitions until the global cooldown elapses", async () => {
    const clock = new FakeClock();
    const g = new Governor({ minBackoffMs: 1_000 }, clock);

    g.penalize("wss://clio.example");
    expect(g.stats().cooldownUntil).toBe(1_000);

    let acquired = false;
    const p = g.acquire().then((release) => {
      acquired = true;
      return release;
    });

    await tick();
    expect(acquired).toBe(false); // held despite a free slot

    await clock.advance(999);
    await tick();
    expect(acquired).toBe(false); // still one ms short

    await clock.advance(1);
    const release = await p;
    expect(acquired).toBe(true);
    release();
  });

  it("only resets escalation on success once the cooldown has elapsed", async () => {
    const clock = new FakeClock();
    const g = new Governor({ minBackoffMs: 1_000, backoffFactor: 2 }, clock);

    g.penalize();
    g.penalize();
    expect(g.stats().consecutivePenalties).toBe(2);

    // A success from a request that slipped out before the penalty must NOT
    // reset the escalation while the cooldown is still active.
    g.reward();
    expect(g.stats().consecutivePenalties).toBe(2);

    await clock.advance(g.stats().cooldownUntil);
    g.reward();
    expect(g.stats().consecutivePenalties).toBe(0);
    expect(g.stats().currentBackoffMs).toBe(0);
  });

  it("surfaces a rate-limit event per penalty for the dashboard", () => {
    const clock = new FakeClock();
    const g = new Governor({ minBackoffMs: 1_000, backoffFactor: 2 }, clock);

    const events: RateLimitEvent[] = [];
    const off = g.rateLimits.on((e) => events.push(e));

    g.penalize("wss://clio.example");
    g.penalize("wss://clio.example");
    off();
    g.penalize("wss://clio.example"); // not observed after unsubscribe

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      endpoint: "wss://clio.example",
      backoffMs: 1_000,
      consecutive: 1,
    });
    expect(events[1]).toMatchObject({ backoffMs: 2_000, consecutive: 2 });
    expect(events[0]!.at).toBeInstanceOf(Date);
  });
});
