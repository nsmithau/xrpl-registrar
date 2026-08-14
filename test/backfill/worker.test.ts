import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ClioRequest } from "../../src/clio/types.js";
import { openArchiveDatabase, type Database } from "../../src/db/index.js";
import { IssuanceRepository } from "../../src/db/repositories/issuances.js";
import { BackfillWorker } from "../../src/backfill/worker.js";
import type { BinaryTxEntry } from "../../src/backfill/pages.js";
import type { IngestTransaction } from "../../src/db/repositories/transactions.js";
import { fakeReader } from "../discovery/fakes.js";

const ACCT = "rAcct";

// Identity mapper: the entry's tx_blob doubles as the tx hash, so we can drive
// the worker's resume/idempotency logic without fabricating real XRPL binary.
const idMap = (entry: BinaryTxEntry, account: string, provenance: IngestTransaction["provenance"]): IngestTransaction => ({
  hash: entry.tx_blob,
  ledgerIndex: entry.ledger_index,
  txType: "Payment",
  mptIssuanceId: null,
  txBlob: new Uint8Array(),
  metaBlob: new Uint8Array(),
  provenance,
  accounts: [account],
});

const e = (blob: string, ledger: number): BinaryTxEntry => ({
  tx_blob: blob,
  meta_blob: "",
  ledger_index: ledger,
});

// Three pages: START -> m1 -> m2 -> done. Optionally throw on a given marker to
// simulate a crash, and record the markers requested.
function pageServer(opts: { throwOn?: string; seen?: unknown[] } = {}) {
  const pages: Record<string, { entries: BinaryTxEntry[]; marker: string | undefined }> = {
    START: { entries: [e("E1", 100), e("E2", 101)], marker: "m1" },
    m1: { entries: [e("E3", 102)], marker: "m2" },
    m2: { entries: [e("E4", 103)], marker: undefined },
  };
  return fakeReader((req: ClioRequest) => {
    if (req.command !== "account_tx") return {};
    const key = req.marker === undefined ? "START" : String(req.marker);
    opts.seen?.push(req.marker);
    if (opts.throwOn && key === opts.throwOn) throw new Error("simulated crash");
    const page = pages[key]!;
    return { transactions: page.entries, marker: page.marker };
  });
}

async function txCount(db: Database): Promise<number> {
  const { rows } = await db.query<{ n: number | string }>("SELECT count(*)::bigint AS n FROM transactions");
  return Number(rows[0]!.n);
}

describe("BackfillWorker", () => {
  let db: Database;
  let issuanceId: number;

  beforeEach(async () => {
    db = await openArchiveDatabase();
    const issuance = await new IssuanceRepository(db).create({ kind: "mpt", mptIssuanceId: "MPT_A" });
    issuanceId = issuance.id;
    await db.query("INSERT INTO accounts (address) VALUES ($1)", [ACCT]);
  });

  afterEach(async () => {
    await db.close();
  });

  it("backfills an account to completion, checkpointing and recording coverage", async () => {
    const worker = new BackfillWorker({ client: pageServer(), db, mapEntry: idMap });
    await worker.enqueue(issuanceId, [ACCT], 50);
    const job = await worker.jobs.claim(issuanceId);
    const done = await worker.runJob(job!);

    expect(done.status).toBe("completed");
    expect(done.txCount).toBe(4);
    expect(done.lastMarker).toBeUndefined();
    expect(await txCount(db)).toBe(4);

    const cov = await db.query<{ from_ledger: string; to_ledger: string }>(
      "SELECT from_ledger, to_ledger FROM coverage WHERE address = $1",
      [ACCT],
    );
    expect(cov.rows).toHaveLength(1);
    expect(Number(cov.rows[0]!.from_ledger)).toBe(50);
    expect(Number(cov.rows[0]!.to_ledger)).toBe(103); // last ledger reached
  });

  it("passes the ledger lower bound (bounded backfill)", async () => {
    const seen: unknown[] = [];
    const capturing = fakeReader((req: ClioRequest) => {
      if (req.command === "account_tx") seen.push(req.ledger_index_min);
      return { transactions: [], marker: undefined };
    });
    const worker = new BackfillWorker({ client: capturing, db, mapEntry: idMap });
    await worker.enqueue(issuanceId, [ACCT], 5_000_000);
    await worker.runJob((await worker.jobs.claim(issuanceId))!);
    expect(seen[0]).toBe(5_000_000);
  });

  it("omits the ledger lower bound when starting from 0 (Clio rejects ledger_index_min: 0)", async () => {
    const seen: unknown[] = [];
    const capturing = fakeReader((req: ClioRequest) => {
      if (req.command === "account_tx") seen.push(req.ledger_index_min);
      return { transactions: [], marker: undefined };
    });
    const worker = new BackfillWorker({ client: capturing, db, mapEntry: idMap });
    await worker.enqueue(issuanceId, [ACCT], 0);
    await worker.runJob((await worker.jobs.claim(issuanceId))!);
    expect(seen[0]).toBeUndefined();
  });

  it("resumes from its checkpoint after a crash with no gaps or duplicates", async () => {
    // Crash while requesting the final page (m2), after two pages committed.
    const worker1 = new BackfillWorker({ client: pageServer({ throwOn: "m2" }), db, mapEntry: idMap });
    await worker1.enqueue(issuanceId, [ACCT], 0);
    const job = await worker1.jobs.claim(issuanceId);
    await expect(worker1.runJob(job!)).rejects.toThrow("simulated crash");

    // Two pages persisted; cursor parked at m2; job marked failed.
    expect(await txCount(db)).toBe(3);
    const crashed = await worker1.jobs.get(job!.id);
    expect(crashed!.status).toBe("failed");
    expect(crashed!.lastMarker).toBe("m2");

    // Resume with a healthy client.
    const seen: unknown[] = [];
    const worker2 = new BackfillWorker({ client: pageServer({ seen }), db, mapEntry: idMap });
    const done = await worker2.runJob(crashed!);

    expect(seen[0]).toBe("m2"); // resumed from the checkpoint, not the start
    expect(done.status).toBe("completed");
    expect(await txCount(db)).toBe(4); // E4 added; E1–E3 not duplicated
    expect(done.txCount).toBe(4);
  });

  it("backfills multiple accounts concurrently, claiming each job exactly once", async () => {
    const accts = ["rA", "rB", "rC", "rD", "rE", "rF"];
    for (const a of accts) await db.query("INSERT INTO accounts (address) VALUES ($1) ON CONFLICT DO NOTHING", [a]);
    const worker = new BackfillWorker({ client: pageServer(), db, mapEntry: idMap, concurrency: 4 });
    await worker.enqueue(issuanceId, accts, 0);

    const { processed } = await worker.runIssuance(issuanceId);

    expect(processed).toBe(accts.length); // no job claimed twice, none missed
    const jobs = await worker.jobs.listForIssuance(issuanceId);
    expect(jobs.every((j) => j.status === "completed")).toBe(true);
    // The fake serves the same 4 tx to every account: deduped to 4 rows, with
    // one link per (account) — proving concurrent ingest stays consistent.
    expect(await txCount(db)).toBe(4);
    const links = await db.query<{ n: number | string }>("SELECT count(*)::bigint AS n FROM account_transactions");
    expect(Number(links.rows[0]!.n)).toBe(4 * accts.length);
  });

  it("calls the deriveDeltas hook once per ingested transaction, on the ingest tx", async () => {
    const seen: string[] = [];
    const worker = new BackfillWorker({
      client: pageServer(),
      db,
      mapEntry: idMap,
      deriveDeltas: (_q, hash) => {
        seen.push(hash);
        return Promise.resolve();
      },
    });
    await worker.enqueue(issuanceId, [ACCT], 0);
    await worker.runJob((await worker.jobs.claim(issuanceId))!);
    // idMap uses tx_blob as the hash; the three pages carry E1..E4.
    expect(seen).toEqual(["E1", "E2", "E3", "E4"]);
  });

  it("isolates a failing account: marks it failed and finishes the others", async () => {
    await db.query("INSERT INTO accounts (address) VALUES ('rOK'),('rBAD') ON CONFLICT DO NOTHING");
    const client = fakeReader((req: ClioRequest) => {
      if (req.command !== "account_tx") return {};
      if (req.account === "rBAD") throw new Error("simulated upstream failure");
      return { transactions: [e("E1", 100)], marker: undefined };
    });
    const worker = new BackfillWorker({ client, db, mapEntry: idMap });
    await worker.enqueue(issuanceId, ["rOK", "rBAD"], 0);

    const { processed, failed } = await worker.runIssuance(issuanceId);

    expect(processed).toBe(1); // rOK completed despite rBAD failing
    expect(failed).toBe(1);
    const jobs = await worker.jobs.listForIssuance(issuanceId);
    const status = Object.fromEntries(jobs.map((j) => [j.address, j.status]));
    expect(status).toMatchObject({ rOK: "completed", rBAD: "failed" });
  });

  it("is idempotent when a completed job is re-run", async () => {
    const worker = new BackfillWorker({ client: pageServer(), db, mapEntry: idMap });
    await worker.enqueue(issuanceId, [ACCT], 0);
    const done = await worker.runJob((await worker.jobs.claim(issuanceId))!);
    expect(await txCount(db)).toBe(4);

    // Re-running re-pages from the start but ingest is idempotent.
    await worker.runJob(done);
    expect(await txCount(db)).toBe(4);
  });
});
