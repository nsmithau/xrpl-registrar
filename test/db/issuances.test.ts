import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openArchiveDatabase, type Database } from "../../src/db/index.js";
import { IssuanceRepository } from "../../src/db/repositories/issuances.js";

describe("IssuanceRepository", () => {
  let db: Database;
  let repo: IssuanceRepository;

  beforeEach(async () => {
    db = await openArchiveDatabase();
    repo = new IssuanceRepository(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it("creates and reads back an MPT issuance", async () => {
    const created = await repo.create({
      kind: "mpt",
      mptIssuanceId: "00000000ABCDEF",
      requiresAuth: true,
    });

    expect(created.id).toBeGreaterThan(0);
    expect(created.kind).toBe("mpt");
    expect(created.mptIssuanceId).toBe("00000000ABCDEF");
    expect(created.currency).toBeNull();
    expect(created.requiresAuth).toBe(true);
    expect(created.discoveryStrategy).toBe("auto");
    expect(created.enabled).toBe(true);
    expect(created.backfillFromLedger).toBe(0);
    expect(new Date(created.createdAt).toISOString()).toBe(created.createdAt);

    expect(await repo.getById(created.id)).toEqual(created);
  });

  it("creates an IOU issuance and lists both", async () => {
    await repo.create({ kind: "mpt", mptIssuanceId: "AA" });
    const iou = await repo.create({
      kind: "iou",
      currency: "USD",
      issuerAccount: "rIssuerExample",
      discoveryStrategy: "trustline",
    });

    expect(iou.kind).toBe("iou");
    expect(iou.currency).toBe("USD");
    expect(iou.issuerAccount).toBe("rIssuerExample");
    expect(iou.mptIssuanceId).toBeNull();

    const all = await repo.list();
    expect(all).toHaveLength(2);
    expect(all.map((i) => i.kind)).toEqual(["mpt", "iou"]);
  });

  it("enforces uniqueness on mpt_issuance_id", async () => {
    await repo.create({ kind: "mpt", mptIssuanceId: "DUP" });
    await expect(repo.create({ kind: "mpt", mptIssuanceId: "DUP" })).rejects.toThrow();
  });

  it("toggles enabled", async () => {
    const created = await repo.create({ kind: "mpt", mptIssuanceId: "TOGGLE" });
    await repo.setEnabled(created.id, false);
    expect((await repo.getById(created.id))?.enabled).toBe(false);
  });

  it("returns null for an unknown id", async () => {
    expect(await repo.getById(9999)).toBeNull();
  });
});
