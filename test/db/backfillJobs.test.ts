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

  it("claims pending jobs in order and marks them running", async () => {
    await jobs.enqueueMany(issuanceId, ["rA", "rB"], 0);
    const a = await jobs.claimNext(issuanceId);
    expect(a?.address).toBe("rA");
    expect(a?.status).toBe("running");
    // Already-running rA is still claimable (interrupted-job semantics), and is
    // the lowest id, so it comes back before rB.
    const next = await jobs.claimNext(issuanceId);
    expect(next?.address).toBe("rA");
  });

  it("does not reselect failed jobs", async () => {
    await jobs.enqueue(issuanceId, "rA", 0);
    const job = await jobs.claimNext(issuanceId);
    await jobs.fail(job!.id);
    expect(await jobs.claimNext(issuanceId)).toBeNull();
  });
});
