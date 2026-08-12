import { describe, expect, it } from "vitest";

import { resolveStrategy } from "../../src/discovery/resolve.js";

describe("resolveStrategy", () => {
  it("uses trustline for IOUs", () => {
    expect(resolveStrategy({ kind: "iou", currency: "USD", issuer: "rI" })).toBe("trustline");
  });

  it("uses authorization for auth-required MPTs, traversal otherwise", () => {
    expect(resolveStrategy({ kind: "mpt", mptIssuanceId: "A", requiresAuth: true })).toBe(
      "authorization",
    );
    expect(resolveStrategy({ kind: "mpt", mptIssuanceId: "A", requiresAuth: false })).toBe(
      "traversal",
    );
  });

  it("falls back to traversal for an MPT when require-auth is unknown", () => {
    expect(resolveStrategy({ kind: "mpt", mptIssuanceId: "A", requiresAuth: null })).toBe(
      "traversal",
    );
    expect(resolveStrategy({ kind: "mpt", mptIssuanceId: "A" })).toBe("traversal");
  });

  it("honours an explicit override", () => {
    expect(
      resolveStrategy({ kind: "mpt", mptIssuanceId: "A", requiresAuth: true, strategy: "traversal" }),
    ).toBe("traversal");
    expect(resolveStrategy({ kind: "iou", currency: "USD", issuer: "rI", strategy: "auto" })).toBe(
      "trustline",
    );
  });
});
