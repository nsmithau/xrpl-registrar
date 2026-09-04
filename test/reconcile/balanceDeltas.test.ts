import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openArchiveDatabase, type Database } from "../../src/db/index.js";
import { IssuanceRepository } from "../../src/db/repositories/issuances.js";
import { TransactionRepository } from "../../src/db/repositories/transactions.js";
import { BalanceDeltaRepository } from "../../src/reconcile/balanceDeltas.js";

const PROV = { sourceEndpoint: "wss://clio.example", fetchedAt: "2026-08-12T00:00:00.000Z" };

describe("BalanceDeltaRepository", () => {
  let db: Database;
  let repo: BalanceDeltaRepository;
  let issuanceId: number;

  beforeEach(async () => {
    db = await openArchiveDatabase();
    repo = new BalanceDeltaRepository(db);
    issuanceId = (await new IssuanceRepository(db).create({ kind: "mpt", mptIssuanceId: "MPT_A" }))
      .id;
    // Deltas reference real transactions (FK); seed the ones the tests use.
    const txns = new TransactionRepository(db);
    await txns.ingest({
      hash: "H1",
      ledgerIndex: 1,
      txType: "Payment",
      txBlob: new Uint8Array([1]),
      metaBlob: new Uint8Array([2]),
      provenance: PROV,
      accounts: ["rA", "rB"],
    });
    await txns.ingest({
      hash: "H2",
      ledgerIndex: 2,
      txType: "Payment",
      txBlob: new Uint8Array([3]),
      metaBlob: new Uint8Array([4]),
      provenance: PROV,
      accounts: ["rA"],
    });
  });

  afterEach(async () => {
    await db.close();
  });

  it("sums deltas per account, including negatives", async () => {
    await repo.upsertMany(issuanceId, [
      { hash: "H1", address: "rA", delta: 10n },
      { hash: "H2", address: "rA", delta: -3n },
      { hash: "H1", address: "rB", delta: 5n },
    ]);
    const balances = await repo.balanceByAccount(issuanceId);
    expect(balances.get("rA")).toBe(7n);
    expect(balances.get("rB")).toBe(5n);
  });

  it("is idempotent: re-deriving the same deltas does not double-count", async () => {
    const rows = [
      { hash: "H1", address: "rA", delta: 10n },
      { hash: "H2", address: "rA", delta: 25n },
    ];
    await repo.upsertMany(issuanceId, rows);
    await repo.upsertMany(issuanceId, rows);
    expect(await repo.count(issuanceId)).toBe(2);
    expect((await repo.balanceByAccount(issuanceId)).get("rA")).toBe(35n);
  });

  it("handles very large integer amounts exactly", async () => {
    const big = 9_000_000_000_000_000_000n; // beyond Number.MAX_SAFE_INTEGER
    await repo.upsertMany(issuanceId, [{ hash: "H1", address: "rA", delta: big }]);
    expect((await repo.balanceByAccount(issuanceId)).get("rA")).toBe(big);
  });
});
