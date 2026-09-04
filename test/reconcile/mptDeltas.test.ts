import { describe, expect, it } from "vitest";

import { mptDeltas } from "../../src/reconcile/mptDeltas.js";
import { compareBalances } from "../../src/reconcile/reconciler.js";

const MPT = "MPT_A";

const modified = (owner: string, mpt: string, prev: string | undefined, final: string) => ({
  ModifiedNode: {
    LedgerEntryType: "MPToken",
    FinalFields: { Account: owner, MPTokenIssuanceID: mpt, MPTAmount: final },
    ...(prev !== undefined ? { PreviousFields: { MPTAmount: prev } } : {}),
  },
});
const created = (owner: string, mpt: string, amount?: string) => ({
  CreatedNode: {
    LedgerEntryType: "MPToken",
    NewFields: {
      Account: owner,
      MPTokenIssuanceID: mpt,
      ...(amount !== undefined ? { MPTAmount: amount } : {}),
    },
  },
});
const deletedN = (owner: string, mpt: string, amount: string) => ({
  DeletedNode: {
    LedgerEntryType: "MPToken",
    FinalFields: { Account: owner, MPTokenIssuanceID: mpt, MPTAmount: amount },
  },
});
const meta = (nodes: unknown[]) => ({ AffectedNodes: nodes });

describe("mptDeltas", () => {
  it("produces equal-and-opposite deltas for a transfer (absent Previous = 0)", () => {
    const d = mptDeltas(
      meta([modified("rSend", MPT, "50", "40"), modified("rRecv", MPT, undefined, "10")]),
      MPT,
    );
    expect(d).toEqual([
      { account: "rSend", delta: -10n },
      { account: "rRecv", delta: 10n },
    ]);
  });

  it("ignores zero-change nodes and other issuances", () => {
    const d = mptDeltas(
      meta([created("rA", MPT), modified("rB", "OTHER", "0", "99"), created("rC", MPT, "5")]),
      MPT,
    );
    expect(d).toEqual([{ account: "rC", delta: 5n }]); // rA opt-in (0) and rB (other) excluded
  });

  it("treats a deletion as removing the remaining balance", () => {
    expect(mptDeltas(meta([deletedN("rA", MPT, "7")]), MPT)).toEqual([
      { account: "rA", delta: -7n },
    ]);
  });
});

describe("compareBalances", () => {
  it("returns no discrepancies when balances agree", () => {
    expect(compareBalances(new Map([["rA", 40n]]), new Map([["rA", 40n]]))).toEqual([]);
  });

  it("flags mismatches, defaulting a missing side to zero", () => {
    expect(compareBalances(new Map([["rA", 40n]]), new Map([["rA", 30n]]))).toEqual([
      { account: "rA", derived: "40", reconstructed: "30" },
    ]);
    expect(compareBalances(new Map([["rB", 5n]]), new Map())).toEqual([
      { account: "rB", derived: "5", reconstructed: "0" },
    ]);
  });
});
