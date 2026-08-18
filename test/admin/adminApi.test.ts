import { encode } from "xrpl";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AdminApi } from "../../src/admin/adminApi.js";
import { openArchiveDatabase, type Database } from "../../src/db/index.js";
import { AccountRepository } from "../../src/db/repositories/accounts.js";
import { TransactionRepository } from "../../src/db/repositories/transactions.js";
import { LedgerTimeRepository } from "../../src/db/repositories/ledgers.js";
import { hexToBytes } from "../../src/util/hex.js";

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
    // Per-issuance transaction stats are scoped via balance_deltas (issuance_id).
    await db.query("INSERT INTO balance_deltas (hash, address, issuance_id, delta) VALUES ('T1','rA',$1,'10'),('T2','rB',$1,'20')", [iss.id]);
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

  it("scopes transaction stats per issuance even when issuances share a holder/issuer", async () => {
    const prov = { sourceEndpoint: "x", fetchedAt: "2026-01-01T00:00:00.000Z" };
    const a = await api.registerIssuance({ kind: "mpt", mptIssuanceId: "MPT_A" });
    const b = await api.registerIssuance({ kind: "mpt", mptIssuanceId: "MPT_B" });
    const accounts = new AccountRepository(db);
    // One holder, in scope for both issuances (as when two MPTs share an issuer).
    await accounts.recordDiscovered(a.id, [{ address: "rShared", discoveredVia: "issuer_sweep", firstAcquisitionLedger: 100 }]);
    await accounts.recordDiscovered(b.id, [{ address: "rShared", discoveredVia: "issuer_sweep", firstAcquisitionLedger: 100 }]);
    const txns = new TransactionRepository(db);
    await txns.ingest({ hash: "TA", ledgerIndex: 100, txType: "Payment", txBlob: new Uint8Array([1]), metaBlob: new Uint8Array([2]), provenance: prov, accounts: ["rShared"] });
    await txns.ingest({ hash: "TB", ledgerIndex: 200, txType: "Payment", txBlob: new Uint8Array([3]), metaBlob: new Uint8Array([4]), provenance: prov, accounts: ["rShared"] });
    // TA affected only A's balance; TB only B's — the per-issuance signal.
    await db.query("INSERT INTO balance_deltas (hash, address, issuance_id, delta) VALUES ('TA','rShared',$1,'10')", [a.id]);
    await db.query("INSERT INTO balance_deltas (hash, address, issuance_id, delta) VALUES ('TB','rShared',$1,'20')", [b.id]);

    const sa = (await api.getIssuance(a.id))!;
    const sb = (await api.getIssuance(b.id))!;
    // Each issuance reports its own latest ledger, not the shared holder's global max.
    expect(sa.latestLedger).toBe(100);
    expect(sb.latestLedger).toBe(200);
    expect(sa.transactions).toBe(1);
    expect(sb.transactions).toBe(1);
  });

  it("reports conservative coverage: the range covered by every account, not the envelope", async () => {
    const iss = await api.registerIssuance({ kind: "mpt", mptIssuanceId: "MPT_C" });
    await new AccountRepository(db).recordDiscovered(iss.id, [
      { address: "rA", discoveredVia: "authorization", firstAcquisitionLedger: 100 },
      { address: "rB", discoveredVia: "authorization", firstAcquisitionLedger: 150 },
    ]);
    await db.query("INSERT INTO coverage (address, from_ledger, to_ledger, reason) VALUES ('rA',100,200,'t'),('rB',150,180,'t')");
    // Conservative window is max(from)=150 … min(to)=180, not the 100–200 envelope.
    expect((await api.getIssuance(iss.id))!.coverage).toEqual({ min: 150, max: 180 });

    // Non-overlapping accounts → no ledger covered by every account → null.
    const iss2 = await api.registerIssuance({ kind: "mpt", mptIssuanceId: "MPT_D" });
    await new AccountRepository(db).recordDiscovered(iss2.id, [
      { address: "rC", discoveredVia: "authorization", firstAcquisitionLedger: 100 },
      { address: "rD", discoveredVia: "authorization", firstAcquisitionLedger: 300 },
    ]);
    await db.query("INSERT INTO coverage (address, from_ledger, to_ledger, reason) VALUES ('rC',100,120,'t'),('rD',300,400,'t')");
    expect((await api.getIssuance(iss2.id))!.coverage).toBeNull();
  });

  it("advances the coverage ceiling to the tail's high-water once the tail has run", async () => {
    const iss = await api.registerIssuance({ kind: "mpt", mptIssuanceId: "MPT_T" });
    await new AccountRepository(db).recordDiscovered(iss.id, [
      { address: "rA", discoveredVia: "authorization", firstAcquisitionLedger: 100 },
      { address: "rB", discoveredVia: "authorization", firstAcquisitionLedger: 100 },
    ]);
    // Backfill left each account complete only up to its last transaction.
    await db.query("INSERT INTO coverage (address, from_ledger, to_ledger, reason) VALUES ('rA',100,150,'t'),('rB',100,180,'t')");
    // Before the tail runs: ceiling is the backfill snapshot min(to)=150.
    expect((await api.getIssuance(iss.id))!.coverage).toEqual({ min: 100, max: 150 });

    // The tail has since processed ledgers up to 20000 → ceiling advances to it,
    // reflecting that the tail keeps every account current (no longer frozen).
    await new LedgerTimeRepository(db).recordMany([
      { ledgerIndex: 19000, closeTimeIso: "2026-06-01T00:00:00Z" },
      { ledgerIndex: 20000, closeTimeIso: "2026-06-01T00:01:00Z" },
    ]);
    expect((await api.getIssuance(iss.id))!.coverage).toEqual({ min: 100, max: 20000 });
  });

  it("reports backfill job progress only while an issuance is backfilling", async () => {
    expect(await api.backfillProgress()).toBeNull(); // nothing enqueued

    const iss = await api.registerIssuance({ kind: "mpt", mptIssuanceId: "MPT_P" });
    await db.query("INSERT INTO accounts (address) VALUES ('rA'),('rB'),('rC')");
    await db.query("INSERT INTO backfill_job (address, issuance_id, status) VALUES ($1,$2,'completed'),($3,$2,'running'),($4,$2,'pending')", ["rA", iss.id, "rB", "rC"]);
    // One issuance with in-flight (pending/running) jobs → 1 of 3 done.
    expect(await api.backfillProgress()).toEqual({ done: 1, total: 3 });

    // All jobs finished → no in-flight issuance → null (counter hidden).
    await db.query("UPDATE backfill_job SET status = 'completed' WHERE issuance_id = $1", [iss.id]);
    expect(await api.backfillProgress()).toBeNull();
  });

  it("reports the latest ledger the archive has observed", async () => {
    expect(await api.latestLedgerSeen()).toBeNull();
    await new LedgerTimeRepository(db).recordMany([
      { ledgerIndex: 100, closeTimeIso: "2026-01-01T00:00:00Z" },
      { ledgerIndex: 250, closeTimeIso: "2026-02-01T00:00:00Z" },
    ]);
    expect(await api.latestLedgerSeen()).toBe(250);
  });

  it("returns the most recent transactions with close time (UTC) and result, newest first", async () => {
    const prov = { sourceEndpoint: "x", fetchedAt: "2026-01-01T00:00:00.000Z" };
    const meta = (result: string): Uint8Array =>
      hexToBytes(encode({ TransactionResult: result, TransactionIndex: 0, AffectedNodes: [] } as unknown as Parameters<typeof encode>[0]));
    const txns = new TransactionRepository(db);
    for (const [hash, ledger, type, res] of [["A", 100, "Payment", "tesSUCCESS"], ["B", 300, "MPTokenAuthorize", "tecNO_PERMISSION"], ["C", 200, "Payment", "tesSUCCESS"]] as const) {
      await txns.ingest({ hash, ledgerIndex: ledger, txType: type, txBlob: new Uint8Array([1]), metaBlob: meta(res), provenance: prov, accounts: [] });
    }
    // The tail records ledger close times; here we seed ledger 300's.
    await new LedgerTimeRepository(db).record({ ledgerIndex: 300, closeTimeIso: "2026-08-17T01:15:30Z" });

    const recent = await api.recentTransactions(2);
    expect(recent.map((r) => r.hash)).toEqual(["B", "C"]); // newest ledger first, limited
    expect(recent[0]).toEqual({
      hash: "B",
      ledgerIndex: 300,
      txType: "MPTokenAuthorize",
      closeTimeUtc: "2026-08-17 01:15:30",
      result: "tecNO_PERMISSION",
    });
    // C's ledger has no recorded close time yet → null date; result still decoded.
    expect(recent[1]).toMatchObject({ hash: "C", closeTimeUtc: null, result: "tesSUCCESS" });
  });

  it("enables/disables and returns null for unknown issuances", async () => {
    const iss = await api.registerIssuance({ kind: "mpt", mptIssuanceId: "MPT_A" });
    expect(await api.setEnabled(iss.id, false)).toBe(true);
    expect((await api.getIssuance(iss.id))!.issuance.enabled).toBe(false);
    expect(await api.setEnabled(9999, true)).toBe(false);
    expect(await api.getIssuance(9999)).toBeNull();
  });
});
