import { describe, expect, it } from "vitest";

import { GapTracker } from "../../src/livetail/gapTracker.js";

describe("GapTracker", () => {
  it("reports no gap for a contiguous sequence", () => {
    const t = new GapTracker();
    expect(t.observe(100)).toBeNull(); // first anchors
    expect(t.observe(101)).toBeNull();
    expect(t.observe(102)).toBeNull();
    expect(t.lastContiguous).toBe(102);
  });

  it("detects a multi-ledger gap and advances past it", () => {
    const t = new GapTracker(100);
    expect(t.observe(101)).toBeNull();
    expect(t.observe(105)).toEqual({ fromLedger: 102, toLedger: 104 });
    expect(t.lastContiguous).toBe(105);
    expect(t.observe(106)).toBeNull();
  });

  it("detects a single missing ledger", () => {
    const t = new GapTracker(50);
    expect(t.observe(52)).toEqual({ fromLedger: 51, toLedger: 51 });
  });

  it("ignores duplicates and out-of-order/old ledgers", () => {
    const t = new GapTracker(200);
    expect(t.observe(201)).toBeNull();
    expect(t.observe(201)).toBeNull(); // duplicate
    expect(t.observe(199)).toBeNull(); // old
    expect(t.lastContiguous).toBe(201);
  });

  it("treats a jump from the backfill anchor to tail start as a gap", () => {
    const t = new GapTracker(1000); // backfill high-water
    expect(t.observe(1005)).toEqual({ fromLedger: 1001, toLedger: 1004 });
  });
});
