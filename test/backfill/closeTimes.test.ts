import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { captureCloseTimes } from "../../src/backfill/closeTimes.js";
import type { ClioRequest } from "../../src/clio/types.js";
import { openArchiveDatabase, type Database } from "../../src/db/index.js";
import { AccountRepository } from "../../src/db/repositories/accounts.js";
import { IssuanceRepository } from "../../src/db/repositories/issuances.js";
import { LedgerTimeRepository } from "../../src/db/repositories/ledgers.js";
import { TransactionRepository } from "../../src/db/repositories/transactions.js";
import { fakeReader } from "../discovery/fakes.js";

const PROV = { sourceEndpoint: "x", fetchedAt: "2026-01-01T00:00:00.000Z" };
const CLOSE: Record<number, string> = { 100: "2026-01-01T00:00:00Z", 200: "2026-06-01T00:00:00Z" };

describe("captureCloseTimes", () => {
  let db: Database;
  let issuanceId: number;

  beforeEach(async () => {
    db = await openArchiveDatabase();
    issuanceId = (await new IssuanceRepository(db).create({ kind: "mpt", mptIssuanceId: "MPT_A" })).id;
    await new AccountRepository(db).recordDiscovered(issuanceId, [
      { address: "rA", discoveredVia: "authorization", firstAcquisitionLedger: 100 },
    ]);
    const txns = new TransactionRepository(db);
    await txns.ingest({ hash: "T1", ledgerIndex: 100, txType: "Payment", txBlob: new Uint8Array([1]), metaBlob: new Uint8Array([2]), provenance: PROV, accounts: ["rA"] });
    await txns.ingest({ hash: "T2", ledgerIndex: 200, txType: "Payment", txBlob: new Uint8Array([3]), metaBlob: new Uint8Array([4]), provenance: PROV, accounts: ["rA"] });
  });
  afterEach(async () => {
    await db.close();
  });

  it("captures close times for the issuance's ledgers, once", async () => {
    const client = fakeReader((req: ClioRequest) => {
      expect(req.command).toBe("ledger");
      return { ledger: { close_time_iso: CLOSE[req.ledger_index as number] } };
    });

    expect(await captureCloseTimes(client, db, issuanceId)).toBe(2);
    const ledgers = new LedgerTimeRepository(db);
    expect(await ledgers.count()).toBe(2);
    expect(await ledgers.resolveAtOrBefore("2026-03-01T00:00:00Z")).toBe(100);

    // Idempotent: already-recorded ledgers are not re-fetched.
    expect(await captureCloseTimes(client, db, issuanceId)).toBe(0);
  });
});
