import { describe, expect, it } from "vitest";

import { ActivityRegistry } from "../../src/admin/activity.js";

describe("ActivityRegistry", () => {
  it("reports idle before anything runs", () => {
    const reg = new ActivityRegistry();
    const snap = reg.snapshot();
    expect(snap.backfill).toEqual({
      active: 0,
      running: false,
      lastStartedAt: null,
      lastFinishedAt: null,
      detail: null,
    });
    expect(snap.discovery.running).toBe(false);
  });

  it("marks a kind running for the duration of track(), then idle with a finish time", async () => {
    const reg = new ActivityRegistry();
    let observedWhileRunning = false;

    const result = await reg.track("backfill", "healing 100-200", async () => {
      const s = reg.snapshot().backfill;
      observedWhileRunning = s.running && s.active === 1 && s.detail === "healing 100-200";
      return 42;
    });

    expect(result).toBe(42);
    expect(observedWhileRunning).toBe(true);
    const after = reg.snapshot().backfill;
    expect(after.running).toBe(false);
    expect(after.active).toBe(0);
    expect(after.detail).toBeNull(); // cleared once idle
    expect(after.lastStartedAt).not.toBeNull();
    expect(after.lastFinishedAt).not.toBeNull();
  });

  it("reference-counts overlapping operations of the same kind", () => {
    const reg = new ActivityRegistry();
    reg.begin("discovery");
    reg.begin("discovery");
    expect(reg.snapshot().discovery.active).toBe(2);
    reg.end("discovery");
    expect(reg.snapshot().discovery.running).toBe(true); // still one in flight
    reg.end("discovery");
    expect(reg.snapshot().discovery.running).toBe(false);
  });

  it("ends the activity even when the tracked function throws", async () => {
    const reg = new ActivityRegistry();
    await expect(
      reg.track("discovery", "scan", () => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom");
    expect(reg.snapshot().discovery.running).toBe(false);
    expect(reg.snapshot().discovery.lastFinishedAt).not.toBeNull();
  });

  it("keeps the two kinds independent", async () => {
    const reg = new ActivityRegistry();
    reg.begin("backfill");
    const snap = reg.snapshot();
    expect(snap.backfill.running).toBe(true);
    expect(snap.discovery.running).toBe(false);
    reg.end("backfill");
  });
});
