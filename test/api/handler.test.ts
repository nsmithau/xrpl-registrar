import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encode } from "xrpl";

import { hexToBytes } from "../../src/util/hex.js";
import { openArchiveDatabase, type Database } from "../../src/db/index.js";
import { IssuanceRepository } from "../../src/db/repositories/issuances.js";
import { TransactionRepository } from "../../src/db/repositories/transactions.js";
import { ArchiveApi } from "../../src/api/handler.js";
import type { Forwarder, ForwardResult } from "../../src/api/forwarder.js";
import type { ApiRequest } from "../../src/api/types.js";

const PROV = { sourceEndpoint: "wss://clio.example", fetchedAt: "2026-08-12T00:00:00.000Z" };

function warningIds(warnings: { id: number }[]): number[] {
  return warnings.map((w) => w.id);
}

class FakeForwarder implements Forwarder {
  calls: ApiRequest[] = [];
  forward(req: ApiRequest): Promise<ForwardResult> {
    this.calls.push(req);
    return Promise.resolve({
      result: { status: "success", info: { network_id: 1 }, forwarded_marker: true },
      warnings: [{ id: 2001, message: "clio" }],
    });
  }
}

async function seed(db: Database): Promise<void> {
  await new IssuanceRepository(db).create({ kind: "mpt", mptIssuanceId: "MPT_A" });
  const txns = new TransactionRepository(db);
  await txns.ingest({
    hash: "T1",
    ledgerIndex: 100,
    txType: "Payment",
    txBlob: new Uint8Array([1, 2]),
    metaBlob: new Uint8Array([3]),
    provenance: PROV,
    accounts: ["rInScope"],
  });
  await txns.ingest({
    hash: "T2",
    ledgerIndex: 200,
    txType: "Payment",
    txBlob: new Uint8Array([4]),
    metaBlob: new Uint8Array([5]),
    provenance: PROV,
    accounts: ["rInScope"],
  });
  await db.query(
    "INSERT INTO coverage (address, from_ledger, to_ledger, reason) VALUES ($1, $2, $3, $4)",
    ["rInScope", 100, 200, "test"],
  );
}

describe("ArchiveApi", () => {
  let db: Database;
  let api: ArchiveApi;
  let forwarder: FakeForwarder;

  beforeEach(async () => {
    db = await openArchiveDatabase();
    await seed(db);
    forwarder = new FakeForwarder();
    api = new ArchiveApi({ db, forwarder });
  });

  afterEach(async () => {
    await db.close();
  });

  it("rejects requests that omit or misdeclare api_version", async () => {
    const missing = await api.handle({ command: "account_tx", account: "rInScope" });
    expect(missing.result.error).toBe("invalidApiVersion");
    const v1 = await api.handle({ command: "account_tx", account: "rInScope", api_version: 1 });
    expect(v1.result.error).toBe("invalidApiVersion");
  });

  it("attaches the Clio (2001) and filtered-archive (65001) warnings", async () => {
    const res = await api.handle({
      command: "account_tx",
      account: "rInScope",
      api_version: 2,
      binary: true,
    });
    expect(warningIds(res.warnings)).toEqual(expect.arrayContaining([2001, 65001]));
  });

  it("serves an in-scope account_tx with honest coverage bounds", async () => {
    const res = await api.handle({
      command: "account_tx",
      account: "rInScope",
      api_version: 2,
      binary: true,
    });
    expect(res.forwarded).toBe(false);
    expect(res.result.status).toBe("success");
    expect(res.result.ledger_index_min).toBe(100);
    expect(res.result.ledger_index_max).toBe(200);
    const txs = res.result.transactions as unknown[];
    expect(txs).toHaveLength(2);
  });

  it("fails closed with notInArchive for an out-of-scope account", async () => {
    const res = await api.handle({ command: "account_tx", account: "rStranger", api_version: 2 });
    expect(res.result.error).toBe("notInArchive");
    expect(res.forwarded).toBe(false);
    const details = res.result.details as { scope: { issuances: unknown[] } };
    expect(details.scope.issuances.length).toBe(1);
  });

  it("warns when the requested range exceeds coverage", async () => {
    const res = await api.handle({
      command: "account_tx",
      account: "rInScope",
      api_version: 2,
      binary: true,
      ledger_index_max: 999,
    });
    expect(warningIds(res.warnings)).toContain(65003);
  });

  it("serves tx by hash and fails closed when absent", async () => {
    const present = await api.handle({
      command: "tx",
      transaction: "T1",
      api_version: 2,
      binary: true,
    });
    expect(present.result.status).toBe("success");
    expect(present.result.hash).toBe("T1");
    const absent = await api.handle({ command: "tx", transaction: "NOPE", api_version: 2 });
    expect(absent.result.error).toBe("notInArchive");
  });

  it("forwards node-state methods and marks them not archive-sourced", async () => {
    const res = await api.handle({ command: "server_info", api_version: 2 });
    expect(res.forwarded).toBe(true);
    expect(forwarder.calls).toHaveLength(1);
    expect(warningIds(res.warnings)).toContain(65002);
  });

  it("returns an explicit unsupported error for genuinely unknown methods", async () => {
    expect((await api.handle({ command: "frobnicate", api_version: 2 })).result.error).toBe(
      "unsupported",
    );
  });

  it("routes the state-reconstruction methods, failing closed when out of scope", async () => {
    expect(
      (await api.handle({ command: "account_info", account: "rStranger", api_version: 2 })).result
        .error,
    ).toBe("notInArchive");
    expect(
      (await api.handle({ command: "account_lines", account: "rStranger", api_version: 2 })).result
        .error,
    ).toBe("notInArchive");
    expect(
      (await api.handle({ command: "mpt_holders", mpt_issuance_id: "UNTRACKED", api_version: 2 }))
        .result.error,
    ).toBe("notInArchive");
  });

  it("forwards out-of-scope reads only when explicitly enabled", async () => {
    const openApi = new ArchiveApi({ db, forwarder, forwardUnknownAccounts: true });
    const res = await openApi.handle({
      command: "account_tx",
      account: "rStranger",
      api_version: 2,
    });
    expect(res.forwarded).toBe(true);
    expect(warningIds(res.warnings)).toContain(65002);
  });

  it("account_tx paginates by a stable keyset cursor (no dup/skip when the tail ingests mid-page)", async () => {
    // seed gives rInScope T1@100, T2@200; add T3@300 and widen coverage to cover it.
    await new TransactionRepository(db).ingest({
      hash: "T3",
      ledgerIndex: 300,
      txType: "Payment",
      txBlob: new Uint8Array([7]),
      metaBlob: new Uint8Array([7]),
      provenance: PROV,
      accounts: ["rInScope"],
    });
    await db.query("UPDATE coverage SET to_ledger = 400 WHERE address = 'rInScope'");

    const p1 = await api.handle({
      command: "account_tx",
      account: "rInScope",
      api_version: 2,
      binary: true,
      limit: 1,
    });
    const page1 = p1.result.transactions as { ledger_index: number }[];
    expect(page1[0]!.ledger_index).toBe(300); // newest first (DESC)
    const marker = p1.result.marker as string;
    expect(marker).toBe("300:T3");

    // A newer transaction lands between page fetches. With OFFSET paging this
    // would shift the boundary and re-return T3; the keyset cursor is immune.
    await new TransactionRepository(db).ingest({
      hash: "T4",
      ledgerIndex: 400,
      txType: "Payment",
      txBlob: new Uint8Array([8]),
      metaBlob: new Uint8Array([8]),
      provenance: PROV,
      accounts: ["rInScope"],
    });

    const p2 = await api.handle({
      command: "account_tx",
      account: "rInScope",
      api_version: 2,
      binary: true,
      limit: 1,
      marker,
    });
    const page2 = p2.result.transactions as { ledger_index: number }[];
    expect(page2[0]!.ledger_index).toBe(200); // the next-older row, not a repeat of 300 nor the new 400
  });

  it("account_tx reports a real ledger range (never -1) and warns when the account has no coverage row", async () => {
    // In scope (ingest records it in `accounts`) but no coverage row → discovered
    // yet not backfilled. Must report the actual data range, not a -1 echo.
    await new TransactionRepository(db).ingest({
      hash: "T3",
      ledgerIndex: 300,
      txType: "Payment",
      txBlob: new Uint8Array([9]),
      metaBlob: new Uint8Array([9]),
      provenance: PROV,
      accounts: ["rNoCov"],
    });
    const res = await api.handle({
      command: "account_tx",
      account: "rNoCov",
      api_version: 2,
      binary: true,
    });
    expect(res.result.status).toBe("success");
    expect(res.result.ledger_index_min).toBe(300);
    expect(res.result.ledger_index_max).toBe(300);
    expect(warningIds(res.warnings)).toContain(65003); // coverage-not-guaranteed
  });

  it("account_lines reports a real ledger_index (never -1) and warns when the account has no coverage row", async () => {
    // Checksum-valid synthetic addresses (the binary codec validates them).
    const ISS = "rpv7Sieb3Vws9rpMU52C4R7utTHvCfgfwa";
    const HX = "rEjdRNJWChUHPCirDV8QVuMC3ouRVd5Lxq";
    const meta = hexToBytes(
      encode({
        TransactionIndex: 0,
        TransactionResult: "tesSUCCESS",
        AffectedNodes: [
          {
            ModifiedNode: {
              LedgerEntryType: "RippleState",
              LedgerIndex: "0".repeat(64),
              FinalFields: {
                Balance: { currency: "USD", issuer: ISS, value: "-10" },
                LowLimit: { currency: "USD", issuer: ISS, value: "0" },
                HighLimit: { currency: "USD", issuer: HX, value: "1000" },
                Flags: 0,
              },
            },
          },
        ],
      } as unknown as Parameters<typeof encode>[0]),
    );
    await new TransactionRepository(db).ingest({
      hash: "TL",
      ledgerIndex: 300,
      txType: "Payment",
      txBlob: new Uint8Array([1]),
      metaBlob: meta,
      provenance: PROV,
      accounts: [HX],
    });
    const res = await api.handle({ command: "account_lines", account: HX, api_version: 2 });
    expect(res.result.status).toBe("success");
    expect((res.result.lines as unknown[]).length).toBe(1);
    expect(res.result.ledger_index).toBe(300); // real ledger reconstructed through, not -1
    expect(warningIds(res.warnings)).toContain(65003);
  });
});
