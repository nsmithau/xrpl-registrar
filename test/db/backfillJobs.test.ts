import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openArchiveDatabase, type Database } from "../../src/db/index.js";
import { BackfillJobRepository } from "../../src/db/repositories/backfillJobs.js";
import { IssuanceRepository } from "../../src/db/repositories/issuances.js";

describe("BackfillJobRepository", () => {
  let db: Database;
  let jobs: BackfillJobRepository;
  let issuanceId: number;

  beforeEach(async () => {
    db = await openArchiveDatabase();
    jobs = new BackfillJobRepository(db);
    const issuance = await new IssuanceRepository(db).create({ kind: "mpt", mptIssuanceId: "MPT_A" });
    issuanceId = issuance.id;
    await db.query("INSERT INTO accounts (address) VALUES ($1), ($2)", ["rA", "rB"]);
  });

  afterEach(async () => {
    await db.close();
  });

  it("enqueues one job per account, idempotently", async () => {
    const first = await jobs.enqueue(issuanceId, "rA", 100);
    const again = await jobs.enqueue(issuanceId, "rA", 999);
    expect(again.id).toBe(first.id); // no duplicate
    expect(again.fromLedger).toBe(100); // original preserved
    expect((await jobs.listForIssuance(issuanceId)).length).toBe(1);
  });

  it("atomically claims each pending job once, in order", async () => {
    await jobs.enqueueMany(issuanceId, ["rA", "rB"], 0);
    const a = await jobs.claim(issuanceId);
    expect(a?.address).toBe("rA");
    expect(a?.status).toBe("running");
    // rA is now running, so the next claim advances to rB — never the same job.
    const b = await jobs.claim(issuanceId);
    expect(b?.address).toBe("rB");
    expect(await jobs.claim(issuanceId)).toBeNull();
  });

  it("reclaims stale running and failed jobs for retry; neither is directly claimable", async () => {
    await jobs.enqueue(issuanceId, "rA", 0);
    const job = await jobs.claim(issuanceId); // rA -> running
    expect(await jobs.claim(issuanceId)).toBeNull(); // running is not claimable

    // Reclaim (as at startup) returns it to pending and claimable again.
    expect(await jobs.reclaimStale(issuanceId)).toBe(1);
    expect((await jobs.claim(issuanceId))?.address).toBe("rA");

    await jobs.fail(job!.id);
    expect(await jobs.claim(issuanceId)).toBeNull(); // failed is not directly claimable
    // reclaimStale also returns failed jobs to pending, so a later run retries them.
    expect(await jobs.reclaimStale(issuanceId)).toBe(1);
    expect((await jobs.claim(issuanceId))?.address).toBe("rA");
  });
});
