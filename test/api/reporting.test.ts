import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ArchiveApi } from "../../src/api/handler.js";
import { openArchiveDatabase, type Database } from "../../src/db/index.js";
import { AccountRepository } from "../../src/db/repositories/accounts.js";
import { IssuanceRepository } from "../../src/db/repositories/issuances.js";
import { TransactionRepository } from "../../src/db/repositories/transactions.js";
import { BalanceDeltaRepository } from "../../src/reconcile/balanceDeltas.js";
import { LedgerTimeRepository } from "../../src/db/repositories/ledgers.js";

const MPT = "MPT_A";
const PROV = { sourceEndpoint: "wss://clio.example", fetchedAt: "2026-08-12T00:00:00.000Z" };

describe("reporting extensions", () => {
  let db: Database;
  let api: ArchiveApi;
  let issuanceId: number;

  beforeEach(async () => {
    db = await openArchiveDatabase();
    api = new ArchiveApi({ db });
    const iss = await new IssuanceRepository(db).create({ kind: "mpt", mptIssuanceId: MPT });
    issuanceId = iss.id;
    await new AccountRepository(db).recordDiscovered(iss.id, [
      { address: "rA", discoveredVia: "authorization", firstAcquisitionLedger: 100 },
    ]);
    const txns = new TransactionRepository(db);
    await txns.ingest({ hash: "T1", ledgerIndex: 100, txType: "Payment", txBlob: new Uint8Array([1]), metaBlob: new Uint8Array([2]), provenance: PROV, accounts: ["rA"] });
    await txns.ingest({ hash: "T2", ledgerIndex: 200, txType: "Payment", txBlob: new Uint8Array([3]), metaBlob: new Uint8Array([4]), provenance: PROV, accounts: ["rA"] });
    await new BalanceDeltaRepository(db).upsertMany(iss.id, [
      { hash: "T1", address: "rA", delta: 10n },
      { hash: "T2", address: "rA", delta: 25n },
    ]);
    await db.query("INSERT INTO coverage (address, from_ledger, to_ledger, reason) VALUES ($1,100,200,'t')", ["rA"]);
    await new LedgerTimeRepository(db).recordMany([
      { ledgerIndex: 100, closeTimeIso: "2026-01-01T00:00:00Z" },
      { ledgerIndex: 200, closeTimeIso: "2026-06-01T00:00:00Z" },
    ]);
  });

  afterEach(async () => {
    await db.close();
  });

  it("archive_balance_at sums deltas up to the given ledger", async () => {
    const at150 = await api.handle({ command: "archive_balance_at", mpt_issuance_id: MPT, account: "rA", ledger_index: 150, api_version: 2 });
    expect(at150.result.status).toBe("success");
    expect(at150.result.balance).toBe("10"); // only T1 (ledger 100)

    const at250 = await api.handle({ command: "archive_balance_at", mpt_issuance_id: MPT, account: "rA", ledger_index: 250, api_version: 2 });
    expect(at250.result.balance).toBe("35"); // T1 + T2
  });

  it("warns when the balance ledger exceeds coverage", async () => {
    const res = await api.handle({ command: "archive_balance_at", mpt_issuance_id: MPT, account: "rA", ledger_index: 250, api_version: 2 });
    expect(res.warnings.map((w) => w.id)).toContain(65003);
  });

  it("archive_balance_at resolves a date to the ledger in effect then", async () => {
    // 2026-03-01 is after ledger 100 (Jan) but before ledger 200 (Jun).
    const res = await api.handle({ command: "archive_balance_at", mpt_issuance_id: MPT, account: "rA", date: "2026-03-01T00:00:00Z", api_version: 2 });
    expect(res.result.status).toBe("success");
    expect(res.result.ledger_index).toBe(100);
    expect(res.result.balance).toBe("10");
  });

  it("errors when no ledger exists at or before the requested time", async () => {
    const res = await api.handle({ command: "archive_balance_at", mpt_issuance_id: MPT, account: "rA", date: "2020-01-01T00:00:00Z", api_version: 2 });
    expect(res.result.error).toBe("invalidParams");
  });

  it("uses an injected ledger-time resolver for date queries (lazy resolution)", async () => {
    // A resolver that maps any time to ledger 200 (past both deltas) — proving the
    // reporting path consults the injected resolver, not just the cached table.
    const lazy = new ArchiveApi({ db, resolveLedgerTime: () => Promise.resolve(200) });
    const res = await lazy.handle({ command: "archive_balance_at", mpt_issuance_id: MPT, account: "rA", date: "2026-12-01T00:00:00Z", api_version: 2 });
    expect(res.result.ledger_index).toBe(200);
    expect(res.result.balance).toBe("35"); // T1 + T2, both at/under ledger 200
  });

  it("archive_deltas nets change per account over a ledger range", async () => {
    const res = await api.handle({ command: "archive_deltas", mpt_issuance_id: MPT, from_ledger: 150, to_ledger: 300, api_version: 2 });
    expect(res.result.status).toBe("success");
    expect(res.result.mpt_issuance_id).toBe(MPT); // identity echoed above the range
    expect(res.result.deltas).toEqual([{ account: "rA", delta: "25" }]); // only T2 in range
  });

  it("archive_deltas resolves \"validated\" to the archive's latest ledger", async () => {
    const res = await api.handle({ command: "archive_deltas", mpt_issuance_id: MPT, from_ledger: 1, to_ledger: "validated", api_version: 2 });
    expect(res.result.status).toBe("success");
    expect(res.result.to_ledger).toBe(200); // latest transaction ledger
    expect(res.result.deltas).toEqual([{ account: "rA", delta: "35" }]); // T1 + T2 netted
  });

  it("archive_transactions itemises each balance change to its transaction", async () => {
    const res = await api.handle({ command: "archive_transactions", mpt_issuance_id: MPT, from_ledger: 1, to_ledger: "validated", api_version: 2 });
    expect(res.result.status).toBe("success");
    expect(res.result.mpt_issuance_id).toBe(MPT);
    expect(res.result.transactions).toEqual([
      { account: "rA", delta: "10", ledger: 100, hash: "T1" },
      { account: "rA", delta: "25", ledger: 200, hash: "T2" },
    ]);
  });

  it("resolves the issuance by its local issuance_id (uniform across kinds)", async () => {
    // Same result as identifying by mpt_issuance_id, via the numeric id.
    const bal = await api.handle({ command: "archive_balance_at", issuance_id: issuanceId, account: "rA", ledger_index: 250, api_version: 2 });
    expect(bal.result.status).toBe("success");
    expect(bal.result.balance).toBe("35");

    // A numeric string is accepted too (JSON clients may send it either way).
    const asStr = await api.handle({ command: "archive_deltas", issuance_id: String(issuanceId), from_ledger: 150, to_ledger: 300, api_version: 2 });
    expect(asStr.result.deltas).toEqual([{ account: "rA", delta: "25" }]);

    // An unknown id fails closed.
    const miss = await api.handle({ command: "archive_balance_at", issuance_id: 9999, account: "rA", ledger_index: 1, api_version: 2 });
    expect(miss.result.error).toBe("notInArchive");
  });

  it("fails closed for an unknown issuance and validates params", async () => {
    expect((await api.handle({ command: "archive_balance_at", mpt_issuance_id: "NOPE", account: "rA", ledger_index: 1, api_version: 2 })).result.error).toBe("notInArchive");
    expect((await api.handle({ command: "archive_balance_at", mpt_issuance_id: MPT, account: "rA", api_version: 2 })).result.error).toBe("invalidParams");
    expect((await api.handle({ command: "archive_balance_at", mpt_issuance_id: MPT, account: "rStranger", ledger_index: 100, api_version: 2 })).result.error).toBe("notInArchive");
  });
});
