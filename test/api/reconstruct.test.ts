import { describe, expect, it } from "vitest";

import {
  toAccountData,
  toAccountLines,
  toMptHolders,
  type MetaEntry,
} from "../../src/api/state/reconstruct.js";

function entry(ledgerIndex: number, transactionIndex: number, nodes: unknown[]): MetaEntry {
  return { ledgerIndex, transactionIndex, meta: { AffectedNodes: nodes } };
}

const modified = (type: string, id: string, fields: Record<string, unknown>) => ({
  ModifiedNode: { LedgerEntryType: type, LedgerIndex: id, FinalFields: fields },
});
const created = (type: string, id: string, fields: Record<string, unknown>) => ({
  CreatedNode: { LedgerEntryType: type, LedgerIndex: id, NewFields: fields },
});
const deleted = (type: string, id: string, fields: Record<string, unknown>) => ({
  DeletedNode: { LedgerEntryType: type, LedgerIndex: id, FinalFields: fields },
});

describe("toAccountData", () => {
  it("returns the latest AccountRoot state and null when deleted or absent", () => {
    const entries = [
      entry(10, 0, [
        modified("AccountRoot", "ACC", { Account: "rA", Balance: "1000", Sequence: 5 }),
      ]),
      entry(12, 0, [
        modified("AccountRoot", "ACC", { Account: "rA", Balance: "1500", Sequence: 6 }),
      ]),
    ];
    expect(toAccountData(entries, "rA")?.Balance).toBe("1500");
    expect(toAccountData(entries, "rOther")).toBeNull();

    const withDelete = [
      ...entries,
      entry(13, 0, [deleted("AccountRoot", "ACC", { Account: "rA" })]),
    ];
    expect(toAccountData(withDelete, "rA")).toBeNull();
  });
});

describe("toMptHolders", () => {
  it("reconstructs current holders, latest state wins, deleted excluded, filtered by issuance", () => {
    const entries = [
      entry(100, 0, [
        created("MPToken", "OBJ_A", { Account: "rA", MPTokenIssuanceID: "MPT", MPTAmount: "100" }),
      ]),
      entry(101, 0, [
        modified("MPToken", "OBJ_A", { Account: "rA", MPTokenIssuanceID: "MPT", MPTAmount: "250" }),
      ]),
      entry(100, 0, [
        created("MPToken", "OBJ_B", { Account: "rB", MPTokenIssuanceID: "MPT", MPTAmount: "50" }),
      ]),
      entry(102, 0, [
        deleted("MPToken", "OBJ_B", { Account: "rB", MPTokenIssuanceID: "MPT", MPTAmount: "0" }),
      ]),
      entry(100, 0, [
        created("MPToken", "OBJ_C", { Account: "rC", MPTokenIssuanceID: "OTHER", MPTAmount: "5" }),
      ]),
    ];
    expect(toMptHolders(entries, "MPT")).toEqual([
      { account: "rA", mpt_amount: "250", flags: 0, mptoken_index: "OBJ_A" },
    ]);
  });

  it("breaks ties within a ledger by TransactionIndex", () => {
    const entries = [
      entry(200, 0, [
        modified("MPToken", "OBJ_D", { Account: "rD", MPTokenIssuanceID: "MPT", MPTAmount: "10" }),
      ]),
      entry(200, 5, [
        modified("MPToken", "OBJ_D", { Account: "rD", MPTokenIssuanceID: "MPT", MPTAmount: "20" }),
      ]),
    ];
    expect(toMptHolders(entries, "MPT")[0]?.mpt_amount).toBe("20");
  });
});

describe("toAccountLines", () => {
  it("reconstructs a trustline from the account's perspective", () => {
    const state = {
      Balance: { currency: "USD", issuer: "rrrrrrrrrrrrrrrrrrrrBZbvji", value: "25" },
      LowLimit: { currency: "USD", issuer: "rA", value: "1000" },
      HighLimit: { currency: "USD", issuer: "rB", value: "0" },
    };
    const entries = [entry(5, 0, [modified("RippleState", "LINE1", state)])];

    expect(toAccountLines(entries, "rA")).toEqual([
      { account: "rB", currency: "USD", balance: "25", limit: "1000", limit_peer: "0" },
    ]);
    // From the high side, the balance flips sign and the peer swaps.
    expect(toAccountLines(entries, "rB")).toEqual([
      { account: "rA", currency: "USD", balance: "-25", limit: "0", limit_peer: "1000" },
    ]);
  });

  it("excludes deleted trustlines", () => {
    const state = {
      Balance: { currency: "USD", value: "0" },
      LowLimit: { issuer: "rA", value: "0" },
      HighLimit: { issuer: "rB", value: "0" },
    };
    const entries = [
      entry(5, 0, [modified("RippleState", "L", state)]),
      entry(6, 0, [deleted("RippleState", "L", state)]),
    ];
    expect(toAccountLines(entries, "rA")).toEqual([]);
  });
});
