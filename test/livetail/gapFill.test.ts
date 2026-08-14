import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ClioRequest } from "../../src/clio/types.js";
import { openArchiveDatabase, type Database } from "../../src/db/index.js";
import type { BinaryTxEntry } from "../../src/backfill/pages.js";
import type { IngestTransaction } from "../../src/db/repositories/transactions.js";
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

  it("re-fetches each in-scope account bounded to the gap range", async () => {
    const requests: ClioRequest[] = [];
    const client = fakeReader((req) => {
      requests.push(req);
      return { transactions: [], marker: undefined }; // empty: exercise bounds, not decoding
    });

    const n = await backfillGap(client, db, ["rA", "rB"], { fromLedger: 500, toLedger: 800 });

    expect(n).toBe(0);
    expect(requests).toHaveLength(2);
    for (const req of requests) {
      expect(req.command).toBe("account_tx");
      expect(req.forward).toBe(true);
      expect(req.binary).toBe(true);
      expect(req.ledger_index_min).toBe(500);
      expect(req.ledger_index_max).toBe(800);
    }
    expect(requests.map((r) => r.account).sort()).toEqual(["rA", "rB"]);
  });

  it("logs a start and completion line, not a line per account, so a heal is never silent", async () => {
    const client = fakeReader(() => ({ transactions: [], marker: undefined }));
    const logs: Array<{ message: string; meta?: Record<string, unknown> }> = [];
    const logger = {
      info: (message: string, meta?: Record<string, unknown>) => logs.push({ message, ...(meta ? { meta } : {}) }),
      warn: () => {},
      error: () => {},
    };

    await backfillGap(client, db, ["rA", "rB"], { fromLedger: 500, toLedger: 800 }, { logger });

    const messages = logs.map((l) => l.message);
    expect(messages).toContain("gap heal started");
    expect(messages).toContain("gap heal finished");
    // Progress is a throttled running counter, never one line per account.
    expect(messages.filter((m) => m === "gap heal progress")).toHaveLength(0);
    const finished = logs.find((l) => l.message === "gap heal finished");
    expect(finished?.meta?.["ingested"]).toBe(0);
    expect(finished?.meta).toHaveProperty("elapsedMs");
  });

  it("runs onEntry per healed transaction (streaming discovery over the gap)", async () => {
    // Two binary entries per account; a stub mapEntry avoids needing real blobs.
    const client = fakeReader((req: ClioRequest) => {
      if (req.command !== "account_tx") return {};
      return {
        transactions: [
          { tx_blob: `${String(req.account)}-1`, meta_blob: "aa", ledger_index: 600 },
          { tx_blob: `${String(req.account)}-2`, meta_blob: "bb", ledger_index: 601 },
        ],
        marker: undefined,
      };
    });
    // Map an entry to a row using its tx_blob as the hash and meta_blob as bytes.
    const mapEntry = (entry: BinaryTxEntry, account: string): IngestTransaction => ({
      hash: entry.tx_blob,
      ledgerIndex: entry.ledger_index,
      txType: "Payment",
      mptIssuanceId: null,
      txBlob: new Uint8Array(),
      metaBlob: new TextEncoder().encode(entry.meta_blob),
      provenance: PROV,
      accounts: [account],
    });

    const seen: string[] = [];
    const n = await backfillGap(client, db, ["rA"], { fromLedger: 500, toLedger: 800 }, {
      mapEntry,
      onEntry: (metaBlob) => seen.push(new TextDecoder().decode(metaBlob)),
    });

    expect(n).toBe(2);
    expect(seen).toEqual(["aa", "bb"]); // once per healed transaction, post-commit
  });
});
