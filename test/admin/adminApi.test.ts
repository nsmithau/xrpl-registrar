import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AdminApi } from "../../src/admin/adminApi.js";
import { openArchiveDatabase, type Database } from "../../src/db/index.js";
import { AccountRepository } from "../../src/db/repositories/accounts.js";
import { TransactionRepository } from "../../src/db/repositories/transactions.js";
import { LedgerTimeRepository } from "../../src/db/repositories/ledgers.js";

describe("AdminApi", () => {
  let db: Database;
  let api: AdminApi;

  beforeEach(async () => {
    db = await openArchiveDatabase();
    api = new AdminApi(db);
  });
  afterEach(async () => {
    await db.close();
  });

  it("registers MPT and IOU issuances and lists them", async () => {
    const mpt = await api.registerIssuance({ kind: "mpt", mptIssuanceId: "MPT_A", backfillFromLedger: 100 });
    const iou = await api.registerIssuance({ kind: "iou", currency: "USD", issuer: "rISS", discoveryStrategy: "trustline" });
    expect(mpt.kind).toBe("mpt");
    expect(mpt.backfillFromLedger).toBe(100);
    expect(iou.issuerAccount).toBe("rISS");
    expect((await api.listIssuances()).map((i) => i.kind)).toEqual(["mpt", "iou"]);
  });

  it("normalizes an IOU currency at registration and rejects a malformed one", async () => {
    // The 40-hex on-wire form of RLUSD is stored as the readable code.
    const hex = await api.registerIssuance({
      kind: "iou",
      currency: "524C555344000000000000000000000000000000",
      issuer: "rISS",
    });
    expect(hex.currency).toBe("RLUSD");
    // A readable code is stored as-is.
    const readable = await api.registerIssuance({ kind: "iou", currency: "RLUSD", issuer: "rISS2" });
    expect(readable.currency).toBe("RLUSD");
    // XRP and empty are rejected outright rather than silently matching nothing.
    await expect(api.registerIssuance({ kind: "iou", currency: "XRP", issuer: "rISS3" })).rejects.toThrow(/XRP/);
    await expect(api.registerIssuance({ kind: "iou", currency: "", issuer: "rISS4" })).rejects.toThrow(/required/);
  });

  it("reports issuance status: accounts, backfill, coverage, reconciliation", async () => {
    const iss = await api.registerIssuance({ kind: "mpt", mptIssuanceId: "MPT_A" });
    await new AccountRepository(db).recordDiscovered(iss.id, [
      { address: "rA", discoveredVia: "authorization", firstAcquisitionLedger: 100 },
      { address: "rB", discoveredVia: "authorization", firstAcquisitionLedger: 150 },
    ]);
    const txns = new TransactionRepository(db);
    await txns.ingest({ hash: "T1", ledgerIndex: 120, txType: "Payment", txBlob: new Uint8Array([1]), metaBlob: new Uint8Array([2]), provenance: { sourceEndpoint: "x", fetchedAt: "2026-01-01T00:00:00.000Z" }, accounts: ["rA"] });
    await txns.ingest({ hash: "T2", ledgerIndex: 190, txType: "Payment", txBlob: new Uint8Array([3]), metaBlob: new Uint8Array([4]), provenance: { sourceEndpoint: "x", fetchedAt: "2026-01-01T00:00:00.000Z" }, accounts: ["rB"] });
    await db.query("INSERT INTO coverage (address, from_ledger, to_ledger, reason) VALUES ($1,$2,$3,$4)", ["rA", 100, 200, "t"]);
    await db.query("INSERT INTO backfill_job (address, issuance_id, status, tx_count) VALUES ($1,$2,'completed',5)", ["rA", iss.id]);
    await db.query("INSERT INTO backfill_job (address, issuance_id, status, tx_count) VALUES ($1,$2,'running',2)", ["rB", iss.id]);
    await db.query("INSERT INTO reconciliation_run (issuance_id, passed, discrepancies) VALUES ($1, true, 0)", [iss.id]);

    const status = (await api.getIssuance(iss.id))!;
    expect(status.accounts).toBe(2);
    expect(status.transactions).toBe(2);
    expect(status.latestLedger).toBe(190);
    expect(status.backfill).toMatchObject({ completed: 1, running: 1, totalTx: 7 });
    expect(status.coverage).toEqual({ min: 100, max: 200 });
    expect(status.lastReconciliation).toMatchObject({ passed: true, discrepancies: 0 });
  });

  it("reports the latest ledger the archive has observed", async () => {
    expect(await api.latestLedgerSeen()).toBeNull();
    await new LedgerTimeRepository(db).recordMany([
      { ledgerIndex: 100, closeTimeIso: "2026-01-01T00:00:00Z" },
      { ledgerIndex: 250, closeTimeIso: "2026-02-01T00:00:00Z" },
    ]);
    expect(await api.latestLedgerSeen()).toBe(250);
  });

  it("enables/disables and returns null for unknown issuances", async () => {
    const iss = await api.registerIssuance({ kind: "mpt", mptIssuanceId: "MPT_A" });
    expect(await api.setEnabled(iss.id, false)).toBe(true);
    expect((await api.getIssuance(iss.id))!.issuance.enabled).toBe(false);
    expect(await api.setEnabled(9999, true)).toBe(false);
    expect(await api.getIssuance(9999)).toBeNull();
  });
});
