import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openArchiveDatabase, type Database } from "../../src/db/index.js";
import {
  TransactionRepository,
  insertTransactionRowsMany,
  type IngestTransaction,
} from "../../src/db/repositories/transactions.js";

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

describe("insertTransactionRowsMany (batch)", () => {
  let db: Database;

  const tx = (hash: string, ledger: number, accounts: string[]): IngestTransaction => ({
    hash,
    ledgerIndex: ledger,
    txType: "Payment",
    mptIssuanceId: null,
    txBlob: new Uint8Array([1]),
    metaBlob: new Uint8Array([2]),
    provenance: { sourceEndpoint: "wss://clio.example", fetchedAt: "2026-08-12T00:00:00.000Z" },
    accounts,
  });

  const count = async (table: string): Promise<number> =>
    Number((await db.query<{ n: number | string }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n);

  beforeEach(async () => {
    db = await openArchiveDatabase();
  });
  afterEach(async () => {
    await db.close();
  });

  it("batch-inserts transactions, accounts, and links equivalently to the single-row path", async () => {
    await db.transaction((t) =>
      insertTransactionRowsMany(t, [tx("T1", 100, ["rA", "rB"]), tx("T2", 90, ["rB", "rC"])]),
    );

    expect(await count("transactions")).toBe(2);
    expect(await count("account_transactions")).toBe(4); // T1→rA,rB ; T2→rB,rC
    expect(await count("accounts")).toBe(3); // rA, rB, rC
    const { rows } = await db.query<{ first_seen_ledger: number | string }>(
      "SELECT first_seen_ledger FROM accounts WHERE address = 'rB'",
    );
    expect(Number(rows[0]!.first_seen_ledger)).toBe(90); // earliest across the batch
  });

  it("dedupes within a batch and is idempotent across batches", async () => {
    await db.transaction((t) =>
      insertTransactionRowsMany(t, [tx("T1", 100, ["rA"]), tx("T1", 100, ["rA"])]), // dup in one batch
    );
    await db.transaction((t) => insertTransactionRowsMany(t, [tx("T1", 100, ["rA"])])); // and again

    expect(await count("transactions")).toBe(1);
    expect(await count("account_transactions")).toBe(1);
  });

  it("is a no-op for an empty batch", async () => {
    await db.transaction((t) => insertTransactionRowsMany(t, []));
    expect(await count("transactions")).toBe(0);
  });
});
