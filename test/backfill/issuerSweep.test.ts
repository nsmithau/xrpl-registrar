import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ClioRequest } from "../../src/clio/types.js";
import type { BinaryTxEntry } from "../../src/backfill/pages.js";
import { runIssuerBackfill, type MappedEntry } from "../../src/backfill/issuerSweep.js";
import { openArchiveDatabase, type Database } from "../../src/db/index.js";
import { BackfillJobRepository, type BackfillJob } from "../../src/db/repositories/backfillJobs.js";
import { IssuanceRepository } from "../../src/db/repositories/issuances.js";
import { trackedIssuance } from "../../src/reconcile/index.js";
import { fakeReader } from "../discovery/fakes.js";

const MPT = "000000011515151515151515151515151515151515151515";
const ISSUER = "rIssuer";
const PROV = { sourceEndpoint: "wss://clio.example", fetchedAt: "2026-08-12T00:00:00.000Z" };

/** Test mapper: an entry's meta_blob carries the holder address, tx_blob the
 * hash; "SKIP" filters the entry out (stands in for an off-scope transaction). */
const mapEntry = (entry: BinaryTxEntry, issuer: string): MappedEntry | null =>
  entry.meta_blob === "SKIP"
    ? null
    : {
        row: {
          hash: entry.tx_blob,
          ledgerIndex: entry.ledger_index,
          txType: "Payment",
          mptIssuanceId: null,
          txBlob: new Uint8Array(),
          metaBlob: new Uint8Array(),
          provenance: PROV,
          accounts: [issuer, entry.meta_blob],
        },
        meta: null,
      };

async function setup(
  db: Database,
  fromLedger = 0,
): Promise<{ tracked: ReturnType<typeof trackedIssuance>; job: BackfillJob }> {
  const iss = await new IssuanceRepository(db).create({ kind: "mpt", mptIssuanceId: MPT });
  await db.query(
    "INSERT INTO accounts (address, first_seen_ledger) VALUES ($1, NULL) ON CONFLICT DO NOTHING",
    [ISSUER],
  );
  const job = await new BackfillJobRepository(db).enqueue(
    iss.id,
    ISSUER,
    fromLedger,
    null,
    "issuer",
  );
  return { tracked: trackedIssuance(iss), job };
}

describe("runIssuerBackfill", () => {
  let db: Database;
  beforeEach(async () => {
    db = await openArchiveDatabase();
  });
  afterEach(async () => {
    await db.close();
  });

  it("sweeps the issuer once, ingests in-scope txns, and discovers holders", async () => {
    const { tracked, job } = await setup(db);
    const client = fakeReader((req: ClioRequest) => {
      if (req.command !== "account_tx") return {};
      return {
        transactions: [
          { tx_blob: "H1", meta_blob: "rA", ledger_index: 100 },
          { tx_blob: "H2", meta_blob: "rB", ledger_index: 110 },
          { tx_blob: "H3", meta_blob: "SKIP", ledger_index: 120 }, // off-scope, filtered
        ],
      };
    });

    const result = await runIssuerBackfill(client, db, tracked, job, { mapEntry });

    expect(result.ingested).toBe(2);
    expect(result.holders).toBe(2); // rA, rB (issuer is not a holder)
    expect(result.highWater).toBe(110); // SKIP entry does not advance the high-water

    const holders = await db.query<{ address: string; led: number | string }>(
      "SELECT address, first_acquisition_ledger AS led FROM account_issuance WHERE issuance_id = $1 ORDER BY address",
      [tracked.id],
    );
    expect(holders.rows.map((r) => r.address)).toEqual(["rA", "rB"]);
    expect(Number(holders.rows[0]!.led)).toBe(100);

    const done = await new BackfillJobRepository(db).getByAccount(tracked.id, ISSUER);
    expect(done!.status).toBe("completed");
  });

  it("claims [from, highWater] coverage for every holder and the issuer", async () => {
    const { tracked, job } = await setup(db, 50);
    const client = fakeReader((req: ClioRequest) =>
      req.command === "account_tx"
        ? { transactions: [{ tx_blob: "H1", meta_blob: "rA", ledger_index: 200 }] }
        : {},
    );

    await runIssuerBackfill(client, db, tracked, job, { mapEntry });

    const cov = await db.query<{ address: string; lo: number | string; hi: number | string }>(
      "SELECT address, min(from_ledger) AS lo, max(to_ledger) AS hi FROM coverage GROUP BY address ORDER BY address",
    );
    // Holder rA and the issuer are both covered over the whole swept range.
    expect(cov.rows).toEqual([
      { address: "rA", lo: 50, hi: 200 },
      { address: ISSUER, lo: 50, hi: 200 },
    ]);
  });

  it("pages the sweep to exhaustion and resumes from the checkpoint marker", async () => {
    const { tracked, job } = await setup(db);
    let calls = 0;
    const markersSeen: unknown[] = [];
    const client = fakeReader((req: ClioRequest) => {
      if (req.command !== "account_tx") return {};
      markersSeen.push(req.marker);
      calls += 1;
      return calls === 1
        ? {
            transactions: [{ tx_blob: "H1", meta_blob: "rA", ledger_index: 100 }],
            marker: { ledger: 100, seq: 0 },
          }
        : { transactions: [{ tx_blob: "H2", meta_blob: "rB", ledger_index: 200 }] };
    });

    const result = await runIssuerBackfill(client, db, tracked, job, { mapEntry });

    expect(calls).toBe(2);
    expect(markersSeen[1]).toEqual({ ledger: 100, seq: 0 }); // page 2 resumes from page 1's marker
    expect(result.ingested).toBe(2);
    expect(result.highWater).toBe(200);
  });
});
