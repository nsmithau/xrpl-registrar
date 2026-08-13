import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ClioRequest } from "../../src/clio/types.js";
import { openArchiveDatabase, type Database } from "../../src/db/index.js";
import { backfillGap } from "../../src/livetail/gapFill.js";
import { fakeReader } from "../discovery/fakes.js";

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

  it("logs start, per-account progress, and completion so a heal is never silent", async () => {
    const client = fakeReader(() => ({ transactions: [], marker: undefined }));
    const logs: Array<{ message: string; meta?: Record<string, unknown> }> = [];
    const logger = {
      info: (message: string, meta?: Record<string, unknown>) => logs.push({ message, ...(meta ? { meta } : {}) }),
      warn: () => {},
      error: () => {},
    };

    await backfillGap(client, db, ["rA", "rB"], { fromLedger: 500, toLedger: 800 }, logger);

    const messages = logs.map((l) => l.message);
    expect(messages).toContain("gap heal started");
    expect(messages.filter((m) => m === "gap heal progress")).toHaveLength(2); // one per account
    expect(messages).toContain("gap heal finished");
    const finished = logs.find((l) => l.message === "gap heal finished");
    expect(finished?.meta?.["ingested"]).toBe(0);
    expect(finished?.meta).toHaveProperty("elapsedMs");
  });
});
