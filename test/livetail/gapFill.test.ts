import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ClioRequest } from "../../src/clio/types.js";
import { openArchiveDatabase, type Database } from "../../src/db/index.js";
import type { IngestTransaction } from "../../src/db/repositories/transactions.js";
import type { ClioReader } from "../../src/discovery/types.js";
import { backfillGap } from "../../src/livetail/gapFill.js";
import { fakeReader } from "../discovery/fakes.js";

const PROV = { sourceEndpoint: "wss://clio.example", fetchedAt: "2026-08-12T00:00:00.000Z" };

describe("backfillGap", () => {
  let db: Database;

  beforeEach(async () => {
    db = await openArchiveDatabase();
  });

  afterEach(async () => {
    await db.close();
  });

  it("fetches each ledger in the gap range, not one request per account", async () => {
    const requests: ClioRequest[] = [];
    const client = fakeReader((req) => {
      requests.push(req);
      return { ledger: { transactions: [] } }; // empty ledgers: exercise the loop, not decoding
    });

    // Two accounts, four ledgers → four requests (independent of account count).
    const n = await backfillGap(client, db, ["rA", "rB"], { fromLedger: 500, toLedger: 503 });

    expect(n).toBe(0);
    // Fetched with bounded concurrency, so completion order is not guaranteed.
    expect(requests.map((r) => Number(r.ledger_index)).sort((a, b) => a - b)).toEqual([500, 501, 502, 503]);
    for (const req of requests) {
      expect(req.command).toBe("ledger");
      expect(req.transactions).toBe(true);
      expect(req.expand).toBe(true);
      expect(req.binary).toBe(true);
    }
  });

  it("fetches gap ledgers with bounded concurrency, not one at a time", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const client: ClioReader = {
      request: (async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return { result: { ledger: { transactions: [] } }, forwarded: false, warnings: [], provenance: PROV, raw: { result: {} } };
      }) as unknown as ClioReader["request"],
    };

    await backfillGap(client, db, ["rA"], { fromLedger: 1, toLedger: 10 }, { concurrency: 3 });

    expect(maxInFlight).toBeGreaterThan(1); // actually parallel …
    expect(maxInFlight).toBeLessThanOrEqual(3); // … but bounded by the pool
  });

  it("logs a start and completion line, not a line per ledger, so a heal is never silent", async () => {
    const client = fakeReader(() => ({ ledger: { transactions: [] } }));
    const logs: Array<{ message: string; meta?: Record<string, unknown> }> = [];
    const logger = {
      info: (message: string, meta?: Record<string, unknown>) => logs.push({ message, ...(meta ? { meta } : {}) }),
      warn: () => {},
      error: () => {},
    };

    await backfillGap(client, db, ["rA"], { fromLedger: 500, toLedger: 800 }, { logger });

    const messages = logs.map((l) => l.message);
    expect(messages).toContain("gap heal started");
    expect(messages).toContain("gap heal finished");
    // Progress is a throttled running counter, never one line per ledger.
    expect(messages.filter((m) => m === "gap heal progress")).toHaveLength(0);
    const finished = logs.find((l) => l.message === "gap heal finished");
    expect(finished?.meta?.["ingested"]).toBe(0);
    expect(finished?.meta).toHaveProperty("elapsedMs");
  });

  it("ingests only in-scope transactions and runs onEntry per healed transaction", async () => {
    await db.query("INSERT INTO accounts (address) VALUES ('rA') ON CONFLICT DO NOTHING");
    // One ledger with two transactions; a stub mapTx stands in for binary decode.
    const client = fakeReader((req: ClioRequest) => {
      if (req.command !== "ledger") return {};
      return {
        ledger: {
          transactions: [
            { tx_blob: "IN", meta_blob: "m1", hash: "H1" }, // in scope
            { tx_blob: "OUT", meta_blob: "m2", hash: "H2" }, // filtered out
          ],
        },
      };
    });
    // Keep only the in-scope entry; expose its meta_blob as the row's metaBlob.
    const mapTx = (entry: { tx_blob?: string; meta_blob?: string; hash?: string }): IngestTransaction | null =>
      entry.tx_blob === "IN"
        ? {
            hash: entry.hash!,
            ledgerIndex: 500,
            txType: "Payment",
            mptIssuanceId: null,
            txBlob: new Uint8Array(),
            metaBlob: new TextEncoder().encode(entry.meta_blob ?? ""),
            provenance: PROV,
            accounts: ["rA"],
          }
        : null;

    const seen: string[] = [];
    const n = await backfillGap(client, db, ["rA"], { fromLedger: 500, toLedger: 500 }, {
      mapTx,
      onEntry: (metaBlob) => seen.push(new TextDecoder().decode(metaBlob)),
    });

    expect(n).toBe(1); // only the in-scope transaction
    expect(seen).toEqual(["m1"]); // onEntry ran for it, post-commit
    const { rows } = await db.query<{ n: number | string }>("SELECT count(*)::int AS n FROM transactions");
    expect(Number(rows[0]!.n)).toBe(1);
  });
});
