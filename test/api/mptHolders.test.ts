import { encode } from "xrpl";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ArchiveApi } from "../../src/api/handler.js";
import { openArchiveDatabase, type Database } from "../../src/db/index.js";
import { AccountRepository } from "../../src/db/repositories/accounts.js";
import { IssuanceRepository } from "../../src/db/repositories/issuances.js";
import { TransactionRepository } from "../../src/db/repositories/transactions.js";
import { LedgerTimeRepository } from "../../src/db/repositories/ledgers.js";
import { hexToBytes } from "../../src/util/hex.js";

const MPT = "000000011515151515151515151515151515151515151515";
const PROV = { sourceEndpoint: "wss://clio.example", fetchedAt: "2026-08-12T00:00:00.000Z" };

// Synthetic accounts + MPToken object ids (structurally valid, so the metadata
// encodes with the XRPL binary codec) — mirrors a real mpt_holders response.
const HOLDERS = [
  {
    addr: "rEjdRNJWChUHPCirDV8QVuMC3ouRVd5Lxq",
    amount: "60000000",
    oid: "A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1",
  },
  {
    addr: "rHH1MJb32htjymP7c81ZTuq8sWXDeMN5Ak",
    amount: "20000000",
    oid: "B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2",
  },
  {
    addr: "rJifH41kVnbUZivxpnx5RvKtxD9riEGA5G",
    amount: "80000000",
    oid: "C3C3C3C3C3C3C3C3C3C3C3C3C3C3C3C3C3C3C3C3C3C3C3C3C3C3C3C3C3C3C3C3",
  },
];

function metaFor(account: string, amount: string, objectId: string): Uint8Array {
  const meta = {
    TransactionIndex: 0,
    TransactionResult: "tesSUCCESS",
    AffectedNodes: [
      {
        CreatedNode: {
          LedgerEntryType: "MPToken",
          LedgerIndex: objectId,
          NewFields: { Account: account, MPTokenIssuanceID: MPT, MPTAmount: amount, Flags: 0 },
        },
      },
    ],
  };
  return hexToBytes(encode(meta as unknown as Parameters<typeof encode>[0]));
}

describe("mpt_holders (Clio-compatible shape)", () => {
  let db: Database;
  let api: ArchiveApi;

  beforeEach(async () => {
    db = await openArchiveDatabase();
    api = new ArchiveApi({ db });
    const iss = await new IssuanceRepository(db).create({ kind: "mpt", mptIssuanceId: MPT });
    const accounts = new AccountRepository(db);
    const txns = new TransactionRepository(db);
    let ledger = 100;
    for (const h of HOLDERS) {
      await accounts.recordDiscovered(iss.id, [
        { address: h.addr, discoveredVia: "issuer_sweep", firstAcquisitionLedger: ledger },
      ]);
      await txns.ingest({
        hash: `T_${h.addr}`,
        ledgerIndex: ledger,
        txType: "Payment",
        txBlob: new Uint8Array([1]),
        metaBlob: metaFor(h.addr, h.amount, h.oid),
        provenance: PROV,
        accounts: [h.addr],
      });
      ledger += 1;
    }
    await new LedgerTimeRepository(db).record({
      ledgerIndex: 500,
      closeTimeIso: "2026-08-17T00:00:00Z",
    });
  });

  afterEach(async () => {
    await db.close();
  });

  it("returns all holders with limit and the archive's latest ledger, no marker when they fit", async () => {
    const res = await api.handle({ command: "mpt_holders", mpt_issuance_id: MPT, api_version: 2 });
    expect(res.result.status).toBe("success");
    expect(res.result.limit).toBe(50); // default page size echoed
    expect(res.result.ledger_index).toBe(500); // latest validated ledger (from ledgers)
    expect(res.result.marker).toBeUndefined(); // 3 holders fit in one page
    expect((res.result.mptokens as unknown[]).length).toBe(3);
  });

  it("paginates with limit + marker, ordered by mptoken_index", async () => {
    const first = await api.handle({
      command: "mpt_holders",
      mpt_issuance_id: MPT,
      limit: 2,
      api_version: 2,
    });
    const page1 = first.result.mptokens as Array<{ account: string; mptoken_index: string }>;
    expect(page1.length).toBe(2);
    // Ordered by mptoken_index ascending (A1A1…, B2B2…, C3C3…) → rEjd, rHH1.
    expect(page1.map((h) => h.account)).toEqual([HOLDERS[0]!.addr, HOLDERS[1]!.addr]);
    expect(first.result.marker).toBe(page1[1]!.mptoken_index);

    const second = await api.handle({
      command: "mpt_holders",
      mpt_issuance_id: MPT,
      limit: 2,
      marker: first.result.marker,
      api_version: 2,
    });
    const page2 = second.result.mptokens as Array<{ account: string }>;
    expect(page2.map((h) => h.account)).toEqual([HOLDERS[2]!.addr]); // remaining holder
    expect(second.result.marker).toBeUndefined(); // last page
  });

  it("echoes the requested ledger_index as the as-of ledger", async () => {
    const res = await api.handle({
      command: "mpt_holders",
      mpt_issuance_id: MPT,
      ledger_index: 100,
      api_version: 2,
    });
    expect(res.result.ledger_index).toBe(100);
    // Only the first holder's MPToken existed at ledger 100.
    expect((res.result.mptokens as unknown[]).length).toBe(1);
  });
});
