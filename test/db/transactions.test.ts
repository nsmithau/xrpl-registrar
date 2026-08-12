import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openArchiveDatabase, type Database } from "../../src/db/index.js";
import { TransactionRepository } from "../../src/db/repositories/transactions.js";

const SAMPLE = {
  hash: "F00D",
  ledgerIndex: 100,
  txType: "Payment",
  mptIssuanceId: "00000000ABCDEF",
  txBlob: new Uint8Array([1, 2, 3, 4]),
  metaBlob: new Uint8Array([5, 6, 7]),
  provenance: { sourceEndpoint: "wss://clio.example", fetchedAt: "2026-08-12T00:00:00.000Z" },
  accounts: ["rAlice", "rBob"],
} as const;

describe("TransactionRepository", () => {
  let db: Database;
  let repo: TransactionRepository;

  beforeEach(async () => {
    db = await openArchiveDatabase();
    repo = new TransactionRepository(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it("ingests a transaction and its account associations", async () => {
    await repo.ingest(SAMPLE);

    expect(await repo.countTransactions()).toBe(1);

    const { rows: links } = await db.query<{ address: string }>(
      "SELECT address FROM account_transactions WHERE hash = $1 ORDER BY address",
      [SAMPLE.hash],
    );
    expect(links.map((r) => r.address)).toEqual(["rAlice", "rBob"]);

    const { rows: accts } = await db.query<{ address: string; first_seen_ledger: number | string }>(
      "SELECT address, first_seen_ledger FROM accounts ORDER BY address",
    );
    expect(accts.map((r) => r.address)).toEqual(["rAlice", "rBob"]);
    expect(Number(accts[0]!.first_seen_ledger)).toBe(100);
  });

  it("is idempotent: re-ingesting the same page adds nothing", async () => {
    await repo.ingest(SAMPLE);
    await repo.ingest(SAMPLE);

    expect(await repo.countTransactions()).toBe(1);
    const { rows } = await db.query<{ n: number | string }>(
      "SELECT count(*)::bigint AS n FROM account_transactions",
    );
    expect(Number(rows[0]!.n)).toBe(2);
  });

  it("retains raw blobs verbatim for re-derivation", async () => {
    await repo.ingest(SAMPLE);
    const { rows } = await db.query<{ tx_blob: Uint8Array; meta_blob: Uint8Array }>(
      "SELECT tx_blob, meta_blob FROM transactions WHERE hash = $1",
      [SAMPLE.hash],
    );
    expect(Array.from(rows[0]!.tx_blob)).toEqual([1, 2, 3, 4]);
    expect(Array.from(rows[0]!.meta_blob)).toEqual([5, 6, 7]);
  });

  it("keeps the earliest first_seen_ledger across ingests", async () => {
    await repo.ingest(SAMPLE);
    await repo.ingest({ ...SAMPLE, hash: "BEEF", ledgerIndex: 50 });

    const { rows } = await db.query<{ first_seen_ledger: number | string }>(
      "SELECT first_seen_ledger FROM accounts WHERE address = $1",
      ["rAlice"],
    );
    expect(Number(rows[0]!.first_seen_ledger)).toBe(50);
  });
});
