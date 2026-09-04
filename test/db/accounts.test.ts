import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openArchiveDatabase, type Database } from "../../src/db/index.js";
import { AccountRepository } from "../../src/db/repositories/accounts.js";
import { IssuanceRepository } from "../../src/db/repositories/issuances.js";

describe("AccountRepository", () => {
  let db: Database;
  let accounts: AccountRepository;
  let issuanceId: number;

  beforeEach(async () => {
    db = await openArchiveDatabase();
    accounts = new AccountRepository(db);
    const issuance = await new IssuanceRepository(db).create({
      kind: "mpt",
      mptIssuanceId: "MPT_A",
    });
    issuanceId = issuance.id;
  });

  afterEach(async () => {
    await db.close();
  });

  it("records discovered accounts and their membership", async () => {
    await accounts.recordDiscovered(issuanceId, [
      { address: "rA", discoveredVia: "traversal", firstAcquisitionLedger: 10 },
      { address: "rB", discoveredVia: "traversal", firstAcquisitionLedger: null },
    ]);

    expect(await accounts.countForIssuance(issuanceId)).toBe(2);
    const rows = await accounts.listForIssuance(issuanceId);
    expect(rows).toEqual([
      { address: "rA", discoveredVia: "traversal", firstAcquisitionLedger: 10 },
      { address: "rB", discoveredVia: "traversal", firstAcquisitionLedger: null },
    ]);
  });

  it("is idempotent and keeps the earliest acquisition ledger", async () => {
    await accounts.recordDiscovered(issuanceId, [
      { address: "rA", discoveredVia: "traversal", firstAcquisitionLedger: 10 },
    ]);
    // Re-run with an earlier ledger for the same account.
    await accounts.recordDiscovered(issuanceId, [
      { address: "rA", discoveredVia: "traversal", firstAcquisitionLedger: 4 },
    ]);

    expect(await accounts.countForIssuance(issuanceId)).toBe(1);
    const rows = await accounts.listForIssuance(issuanceId);
    expect(rows[0]!.firstAcquisitionLedger).toBe(4);
  });
});
