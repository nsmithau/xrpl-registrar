import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ClioRequest } from "../../src/clio/types.js";
import { lazyLedgerTimeResolver } from "../../src/api/ledgerTime.js";
import { openArchiveDatabase, type Database } from "../../src/db/index.js";
import { TransactionRepository } from "../../src/db/repositories/transactions.js";
import { fakeReader } from "../discovery/fakes.js";

const PROV = { sourceEndpoint: "wss://clio.example", fetchedAt: "2026-08-12T00:00:00.000Z" };
const BASE = Date.UTC(2026, 0, 1); // ledger L closes at BASE + L seconds
const isoFor = (ledger: number): string => new Date(BASE + ledger * 1000).toISOString();

describe("lazyLedgerTimeResolver", () => {
  let db: Database;

  beforeEach(async () => {
    db = await openArchiveDatabase();
    const txns = new TransactionRepository(db);
    // Archive spans ledgers 100..200 (only the endpoints need to be present).
    for (const ledger of [100, 200]) {
      await txns.ingest({
        hash: `T${ledger}`,
        ledgerIndex: ledger,
        txType: "Payment",
        txBlob: new Uint8Array([1]),
        metaBlob: new Uint8Array([2]),
        provenance: PROV,
        accounts: [],
      });
    }
  });

  afterEach(async () => {
    await db.close();
  });

  it("binary-searches the ledger range and caches probed close times", async () => {
    let ledgerCalls = 0;
    const client = fakeReader((req: ClioRequest) => {
      if (req.command !== "ledger") return {};
      ledgerCalls += 1;
      return { ledger: { close_time_iso: isoFor(Number(req.ledger_index)) } };
    });
    const resolve = lazyLedgerTimeResolver(client, db);

    // A time just after ledger 150 closes → the ledger in effect is 150.
    const at = await resolve(new Date(BASE + 150 * 1000 + 500).toISOString());
    expect(at).toBe(150);
    expect(ledgerCalls).toBeGreaterThan(0);
    expect(ledgerCalls).toBeLessThanOrEqual(8); // O(log range), not O(range)

    // Repeating the query hits the cache — no further upstream `ledger` calls.
    const before = ledgerCalls;
    const again = await resolve(new Date(BASE + 150 * 1000 + 500).toISOString());
    expect(again).toBe(150);
    expect(ledgerCalls).toBe(before);
  });

  it("returns null for a time before the archive's earliest ledger", async () => {
    const client = fakeReader((req: ClioRequest) =>
      req.command === "ledger" ? { ledger: { close_time_iso: isoFor(Number(req.ledger_index)) } } : {},
    );
    const resolve = lazyLedgerTimeResolver(client, db);
    const at = await resolve(new Date(BASE + 50 * 1000).toISOString()); // before ledger 100
    expect(at).toBeNull();
  });

  it("returns null when the archive holds no transactions", async () => {
    const empty = await openArchiveDatabase();
    try {
      const resolve = lazyLedgerTimeResolver(fakeReader(() => ({})), empty);
      expect(await resolve(isoFor(150))).toBeNull();
    } finally {
      await empty.close();
    }
  });
});
