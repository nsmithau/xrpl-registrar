import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openArchiveDatabase, type Database } from "../../src/db/index.js";
import { LedgerTimeRepository } from "../../src/db/repositories/ledgers.js";

describe("LedgerTimeRepository", () => {
  let db: Database;
  let repo: LedgerTimeRepository;

  beforeEach(async () => {
    db = await openArchiveDatabase();
    repo = new LedgerTimeRepository(db);
    await repo.recordMany([
      { ledgerIndex: 100, closeTimeIso: "2026-01-01T00:00:00Z" },
      { ledgerIndex: 200, closeTimeIso: "2026-06-01T00:00:00Z" },
    ]);
  });
  afterEach(async () => {
    await db.close();
  });

  it("resolves a timestamp to the ledger in effect at or before it", async () => {
    expect(await repo.resolveAtOrBefore("2026-03-01T00:00:00Z")).toBe(100);
    expect(await repo.resolveAtOrBefore("2026-06-01T00:00:00Z")).toBe(200); // inclusive
    expect(await repo.resolveAtOrBefore("2027-01-01T00:00:00Z")).toBe(200);
    expect(await repo.resolveAtOrBefore("2025-01-01T00:00:00Z")).toBeNull();
  });

  it("is immutable per ledger (idempotent record)", async () => {
    await repo.record({ ledgerIndex: 100, closeTimeIso: "1999-01-01T00:00:00Z" });
    expect(await repo.count()).toBe(2);
    expect(await repo.resolveAtOrBefore("2026-03-01T00:00:00Z")).toBe(100); // original kept
  });
});
