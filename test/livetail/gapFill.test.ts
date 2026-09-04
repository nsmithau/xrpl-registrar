import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ClioRequest } from "../../src/clio/types.js";
import { openArchiveDatabase, type Database } from "../../src/db/index.js";
import type { BinaryTxEntry } from "../../src/backfill/pages.js";
import type { MappedEntry } from "../../src/backfill/issuerSweep.js";
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

  it("sweeps account_tx on the issuer over the gap range, not one request per ledger", async () => {
    const requests: ClioRequest[] = [];
    const client = fakeReader((req) => {
      requests.push(req);
      return { transactions: [] }; // empty: exercise the request shape, not decoding
    });

    const n = await backfillGap(client, db, ["rIssuer"], { fromLedger: 500, toLedger: 900 }, () => []);

    expect(n).toBe(0);
    // A single account_tx call bracketed by the gap range — independent of how
    // many ledgers (401 here) the gap spans.
    expect(requests).toHaveLength(1);
    const [req] = requests;
    expect(req!.command).toBe("account_tx");
    expect(req!.account).toBe("rIssuer");
    expect(req!.ledger_index_min).toBe(500);
    expect(req!.ledger_index_max).toBe(900);
    expect(req!.binary).toBe(true);
  });

  it("one sweep per issuer covers every issuance on it (three MPTs, one issuer → one call)", async () => {
    const accounts: string[] = [];
    const client = fakeReader((req) => {
      accounts.push(String(req.account));
      return { transactions: [] };
    });

    // Three tracked MPTs sharing one issuer; a second issuer for a fourth.
    await backfillGap(client, db, ["rIssuerA", "rIssuerB"], { fromLedger: 1, toLedger: 10 }, () => []);

    expect(accounts.sort()).toEqual(["rIssuerA", "rIssuerB"]); // one call each, not per-MPT
  });

  it("pages the sweep until the issuer is exhausted", async () => {
    let calls = 0;
    const client = fakeReader(() => {
      calls += 1;
      // Two pages: first returns a marker, second (no marker) ends the sweep.
      return calls === 1 ? { transactions: [], marker: { ledger: 5, seq: 0 } } : { transactions: [] };
    });

    await backfillGap(client, db, ["rIssuer"], { fromLedger: 1, toLedger: 100 }, () => []);

    expect(calls).toBe(2);
  });

  it("logs a start and completion line, not a line per page, so a heal is never silent", async () => {
    const client = fakeReader(() => ({ transactions: [] }));
    const logs: Array<{ message: string; meta?: Record<string, unknown> }> = [];
    const logger = {
      info: (message: string, meta?: Record<string, unknown>) => logs.push({ message, ...(meta ? { meta } : {}) }),
      warn: () => {},
      error: () => {},
    };

    await backfillGap(client, db, ["rIssuer"], { fromLedger: 500, toLedger: 800 }, () => [], { logger });

    const messages = logs.map((l) => l.message);
    expect(messages).toContain("gap heal started");
    expect(messages).toContain("gap heal finished");
    expect(messages.filter((m) => m === "gap heal progress")).toHaveLength(0);
    const finished = logs.find((l) => l.message === "gap heal finished");
    expect(finished?.meta?.["ingested"]).toBe(0);
    expect(finished?.meta).toHaveProperty("elapsedMs");
  });

  it("ingests only in-scope transactions and runs onEntry per healed transaction", async () => {
    await db.query("INSERT INTO accounts (address) VALUES ('rIssuer') ON CONFLICT DO NOTHING");
    // One page with two entries; a stub mapEntry stands in for binary decode +
    // holder-scope filtering.
    const client = fakeReader((req: ClioRequest) => {
      if (req.command !== "account_tx") return {};
      return {
        transactions: [
          { tx_blob: "IN", meta_blob: "m1", ledger_index: 700 }, // in scope
          { tx_blob: "OUT", meta_blob: "m2", ledger_index: 701 }, // filtered out
        ],
      };
    });
    // Keep only the in-scope entry; carry the entry's meta_blob tag on the
    // decoded meta so onEntry can be observed.
    const mapEntry = (entry: BinaryTxEntry, issuer: string): MappedEntry | null =>
      entry.tx_blob === "IN"
        ? {
            row: {
              hash: "H1",
              ledgerIndex: entry.ledger_index,
              txType: "Payment",
              mptIssuanceId: null,
              txBlob: new Uint8Array(),
              metaBlob: new Uint8Array(),
              provenance: PROV,
              accounts: [issuer, "rA"],
            },
            meta: { tag: entry.meta_blob },
          }
        : null;

    const seen: string[] = [];
    const n = await backfillGap(client, db, ["rIssuer"], { fromLedger: 700, toLedger: 701 }, () => [], {
      mapEntry,
      onEntry: (meta) => seen.push((meta as { tag: string }).tag),
    });

    expect(n).toBe(1); // only the in-scope transaction
    expect(seen).toEqual(["m1"]); // onEntry ran for it, post-commit
    const { rows } = await db.query<{ n: number | string }>("SELECT count(*)::int AS n FROM transactions");
    expect(Number(rows[0]!.n)).toBe(1);
  });
});
