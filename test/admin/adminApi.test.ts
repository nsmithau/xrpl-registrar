import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AdminApi } from "../../src/admin/adminApi.js";
import { openArchiveDatabase, type Database } from "../../src/db/index.js";
import { AccountRepository } from "../../src/db/repositories/accounts.js";

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

  it("reports issuance status: accounts, backfill, coverage, reconciliation", async () => {
    const iss = await api.registerIssuance({ kind: "mpt", mptIssuanceId: "MPT_A" });
    await new AccountRepository(db).recordDiscovered(iss.id, [
      { address: "rA", discoveredVia: "authorization", firstAcquisitionLedger: 100 },
      { address: "rB", discoveredVia: "authorization", firstAcquisitionLedger: 150 },
    ]);
    await db.query("INSERT INTO coverage (address, from_ledger, to_ledger, reason) VALUES ($1,$2,$3,$4)", ["rA", 100, 200, "t"]);
    await db.query("INSERT INTO backfill_job (address, issuance_id, status, tx_count) VALUES ($1,$2,'completed',5)", ["rA", iss.id]);
    await db.query("INSERT INTO backfill_job (address, issuance_id, status, tx_count) VALUES ($1,$2,'running',2)", ["rB", iss.id]);
    await db.query("INSERT INTO reconciliation_run (issuance_id, passed, discrepancies) VALUES ($1, true, 0)", [iss.id]);

    const status = (await api.getIssuance(iss.id))!;
    expect(status.accounts).toBe(2);
    expect(status.backfill).toMatchObject({ completed: 1, running: 1, totalTx: 7 });
    expect(status.coverage).toEqual({ min: 100, max: 200 });
    expect(status.lastReconciliation).toMatchObject({ passed: true, discrepancies: 0 });
  });

  it("enables/disables and returns null for unknown issuances", async () => {
    const iss = await api.registerIssuance({ kind: "mpt", mptIssuanceId: "MPT_A" });
    expect(await api.setEnabled(iss.id, false)).toBe(true);
    expect((await api.getIssuance(iss.id))!.issuance.enabled).toBe(false);
    expect(await api.setEnabled(9999, true)).toBe(false);
    expect(await api.getIssuance(9999)).toBeNull();
  });
});
