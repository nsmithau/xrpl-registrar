import { encode } from "xrpl";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openArchiveDatabase, type Database } from "../../src/db/index.js";
import { IssuanceRepository } from "../../src/db/repositories/issuances.js";
import { TransactionRepository } from "../../src/db/repositories/transactions.js";
import { deriveTxDeltas, trackedIssuance } from "../../src/reconcile/incremental.js";
import { hexToBytes } from "../../src/util/hex.js";

const MPT = "0128C74F0A3198D6E71DE4A6F39C3AD08BD1215358949AE1";
const HOLDER = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const PROV = { sourceEndpoint: "wss://clio.example", fetchedAt: "2026-08-12T00:00:00.000Z" };

// A real (encode/decode-round-trippable) MPToken balance-change metadata blob.
function mptMetaBlob(finalAmt: number, prevAmt: number): Uint8Array {
  const meta = {
    TransactionIndex: 0,
    TransactionResult: "tesSUCCESS",
    AffectedNodes: [
      {
        ModifiedNode: {
          LedgerEntryType: "MPToken",
          LedgerIndex: "0".repeat(64),
          FinalFields: { Account: HOLDER, MPTokenIssuanceID: MPT, MPTAmount: String(finalAmt), Flags: 0 },
          PreviousFields: { MPTAmount: String(prevAmt) },
        },
      },
    ],
  };
  // `encode`'s xrpl typing expects a Transaction/LedgerEntry; metadata is a
  // valid STObject to the binary codec, so cast past the stricter surface type.
  return hexToBytes(encode(meta as unknown as Parameters<typeof encode>[0]));
}

describe("deriveTxDeltas", () => {
  let db: Database;

  beforeEach(async () => {
    db = await openArchiveDatabase();
  });
  afterEach(async () => {
    await db.close();
  });

  async function seedTx(hash: string, metaBlob: Uint8Array): Promise<void> {
    await new TransactionRepository(db).ingest({
      hash,
      ledgerIndex: 100,
      txType: "Payment",
      txBlob: new Uint8Array([1]),
      metaBlob,
      provenance: PROV,
      accounts: [HOLDER],
    });
  }

  it("derives and upserts a transaction's MPT deltas from its meta blob", async () => {
    const iss = await new IssuanceRepository(db).create({ kind: "mpt", mptIssuanceId: MPT });
    const blob = mptMetaBlob(100, 40);
    await seedTx("TX1", blob);

    const n = await deriveTxDeltas(db, [trackedIssuance(iss)], "TX1", blob);
    expect(n).toBe(1);
    const { rows } = await db.query<{ address: string; delta: string }>(
      "SELECT address, delta FROM balance_deltas WHERE issuance_id = $1",
      [iss.id],
    );
    expect(rows).toEqual([{ address: HOLDER, delta: "60" }]); // 100 - 40

    // Re-deriving the same transaction overwrites with the same value (idempotent).
    await deriveTxDeltas(db, [trackedIssuance(iss)], "TX1", blob);
    const { rows: after } = await db.query<{ n: number | string }>(
      "SELECT count(*)::int AS n FROM balance_deltas WHERE issuance_id = $1",
      [iss.id],
    );
    expect(Number(after[0]!.n)).toBe(1);
  });

  it("is a no-op with no issuances or an empty meta blob", async () => {
    const iss = await new IssuanceRepository(db).create({ kind: "mpt", mptIssuanceId: MPT });
    expect(await deriveTxDeltas(db, [], "TX", mptMetaBlob(100, 40))).toBe(0);
    expect(await deriveTxDeltas(db, [trackedIssuance(iss)], "TX", new Uint8Array())).toBe(0);
  });
});
