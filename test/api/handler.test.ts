import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
    hash: "T1", ledgerIndex: 100, txType: "Payment",
    txBlob: new Uint8Array([1, 2]), metaBlob: new Uint8Array([3]),
    provenance: PROV, accounts: ["rInScope"],
  });
  await txns.ingest({
    hash: "T2", ledgerIndex: 200, txType: "Payment",
    txBlob: new Uint8Array([4]), metaBlob: new Uint8Array([5]),
    provenance: PROV, accounts: ["rInScope"],
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
    const res = await api.handle({ command: "account_tx", account: "rInScope", api_version: 2, binary: true });
    expect(warningIds(res.warnings)).toEqual(expect.arrayContaining([2001, 65001]));
  });

  it("serves an in-scope account_tx with honest coverage bounds", async () => {
    const res = await api.handle({ command: "account_tx", account: "rInScope", api_version: 2, binary: true });
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
      command: "account_tx", account: "rInScope", api_version: 2, binary: true, ledger_index_max: 999,
    });
    expect(warningIds(res.warnings)).toContain(65003);
  });

  it("serves tx by hash and fails closed when absent", async () => {
    const present = await api.handle({ command: "tx", transaction: "T1", api_version: 2, binary: true });
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
    expect((await api.handle({ command: "frobnicate", api_version: 2 })).result.error).toBe("unsupported");
  });

  it("routes the state-reconstruction methods, failing closed when out of scope", async () => {
    expect(
      (await api.handle({ command: "account_info", account: "rStranger", api_version: 2 })).result.error,
    ).toBe("notInArchive");
    expect(
      (await api.handle({ command: "account_lines", account: "rStranger", api_version: 2 })).result.error,
    ).toBe("notInArchive");
    expect(
      (await api.handle({ command: "mpt_holders", mpt_issuance_id: "UNTRACKED", api_version: 2 })).result.error,
    ).toBe("notInArchive");
  });

  it("forwards out-of-scope reads only when explicitly enabled", async () => {
    const openApi = new ArchiveApi({ db, forwarder, forwardUnknownAccounts: true });
    const res = await openApi.handle({ command: "account_tx", account: "rStranger", api_version: 2 });
    expect(res.forwarded).toBe(true);
    expect(warningIds(res.warnings)).toContain(65002);
  });
});
