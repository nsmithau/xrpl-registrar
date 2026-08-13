import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Big from "big.js";

import { iouDeltas, toIouBalances } from "../../src/reconcile/iou.js";
import { compareDecimalBalances } from "../../src/reconcile/reconciler.js";
import { BalanceDeltaRepository } from "../../src/reconcile/balanceDeltas.js";
import { openArchiveDatabase, type Database } from "../../src/db/index.js";
import { IssuanceRepository } from "../../src/db/repositories/issuances.js";
import { TransactionRepository } from "../../src/db/repositories/transactions.js";

const ISS = "rIssuer";
const PLACEHOLDER = "rrrrrrrrrrrrrrrrrrrrBZbvji";

// A RippleState fields object: `low`/`high` are the two line parties.
const line = (low: string, high: string, currency: string, value: string) => ({
  Balance: { currency, issuer: PLACEHOLDER, value },
  LowLimit: { currency, issuer: low, value: "0" },
  HighLimit: { currency, issuer: high, value: "0" },
});
const mod = (fields: Record<string, unknown>, prevValue?: string, id = "L1") => ({
  ModifiedNode: {
    LedgerEntryType: "RippleState",
    LedgerIndex: id,
    FinalFields: fields,
    ...(prevValue !== undefined
      ? { PreviousFields: { Balance: { currency: "USD", issuer: PLACEHOLDER, value: prevValue } } }
      : {}),
  },
});
const created = (fields: Record<string, unknown>, id = "L1") => ({
  CreatedNode: { LedgerEntryType: "RippleState", LedgerIndex: id, NewFields: fields },
});
const del = (fields: Record<string, unknown>, id = "L1") => ({
  DeletedNode: { LedgerEntryType: "RippleState", LedgerIndex: id, FinalFields: fields },
});
const meta = (nodes: unknown[]) => ({ AffectedNodes: nodes });

describe("iouDeltas", () => {
  it("credits the holder on the low side (issuer high)", () => {
    expect(iouDeltas(meta([mod(line("rHolder", ISS, "USD", "25"), "0")]), "USD", ISS)).toEqual([
      { account: "rHolder", delta: "25" },
    ]);
  });

  it("credits the holder on the high side (issuer low), flipping the sign", () => {
    // Balance is from the low (issuer) side, so holder-high sees the negation.
    expect(iouDeltas(meta([mod(line(ISS, "rHolder", "USD", "-25"), "0")]), "USD", ISS)).toEqual([
      { account: "rHolder", delta: "25" },
    ]);
  });

  it("handles decimal values exactly and skips unchanged balances", () => {
    expect(iouDeltas(meta([mod(line("rHolder", ISS, "USD", "10.5"), "0.25")]), "USD", ISS)).toEqual([
      { account: "rHolder", delta: "10.25" },
    ]);
    expect(iouDeltas(meta([mod(line("rHolder", ISS, "USD", "5"))]), "USD", ISS)).toEqual([]);
  });

  it("treats create as from-zero and delete as removing the balance", () => {
    expect(iouDeltas(meta([created(line("rHolder", ISS, "USD", "5"))]), "USD", ISS)).toEqual([
      { account: "rHolder", delta: "5" },
    ]);
    expect(iouDeltas(meta([del(line("rHolder", ISS, "USD", "5"))]), "USD", ISS)).toEqual([
      { account: "rHolder", delta: "-5" },
    ]);
  });

  it("ignores other currencies and lines not involving the issuer", () => {
    expect(iouDeltas(meta([mod(line("rHolder", ISS, "EUR", "9"), "0")]), "USD", ISS)).toEqual([]);
    expect(iouDeltas(meta([mod(line("rA", "rB", "USD", "9"), "0")]), "USD", ISS)).toEqual([]);
  });
});

describe("toIouBalances", () => {
  it("reconstructs holder balances and excludes deleted lines", () => {
    const entries = [
      { ledgerIndex: 1, transactionIndex: 0, meta: meta([mod(line("rH", ISS, "USD", "40"), "0", "L_H")]) },
      { ledgerIndex: 2, transactionIndex: 0, meta: meta([mod(line("rGone", ISS, "USD", "10"), "0", "L_G")]) },
      { ledgerIndex: 3, transactionIndex: 0, meta: meta([del(line("rGone", ISS, "USD", "0"), "L_G")]) },
    ];
    const balances = toIouBalances(entries, ISS, "USD");
    expect(balances.get("rH")?.toString()).toBe("40");
    expect(balances.has("rGone")).toBe(false);
  });
});

describe("compareDecimalBalances", () => {
  it("agrees on equal decimals and flags differences", () => {
    expect(compareDecimalBalances(new Map([["rA", new Big("10.5")]]), new Map([["rA", new Big("10.50")]]))).toEqual([]);
    expect(compareDecimalBalances(new Map([["rA", new Big("10.5")]]), new Map())).toEqual([
      { account: "rA", derived: "10.5", reconstructed: "0" },
    ]);
  });
});

describe("BalanceDeltaRepository decimal sums", () => {
  let db: Database;

  beforeEach(async () => {
    db = await openArchiveDatabase();
  });
  afterEach(async () => {
    await db.close();
  });

  it("sums decimal deltas exactly", async () => {
    const issuanceId = (await new IssuanceRepository(db).create({ kind: "iou", currency: "USD", issuerAccount: ISS })).id;
    const txns = new TransactionRepository(db);
    await txns.ingest({ hash: "H1", ledgerIndex: 1, txType: "Payment", txBlob: new Uint8Array([1]), metaBlob: new Uint8Array([2]), provenance: { sourceEndpoint: "x", fetchedAt: "2026-01-01T00:00:00.000Z" }, accounts: ["rH"] });
    await txns.ingest({ hash: "H2", ledgerIndex: 2, txType: "Payment", txBlob: new Uint8Array([3]), metaBlob: new Uint8Array([4]), provenance: { sourceEndpoint: "x", fetchedAt: "2026-01-01T00:00:00.000Z" }, accounts: ["rH"] });
    const repo = new BalanceDeltaRepository(db);
    await repo.upsertMany(issuanceId, [
      { hash: "H1", address: "rH", delta: "10.25" },
      { hash: "H2", address: "rH", delta: "-3.75" },
    ]);
    const balances = await repo.decimalBalanceByAccount(issuanceId);
    expect(balances.get("rH")?.toString()).toBe("6.5");
  });
});
