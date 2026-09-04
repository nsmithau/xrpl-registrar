import { encode } from "xrpl";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openArchiveDatabase, type Database } from "../../src/db/index.js";
import { IssuanceRepository } from "../../src/db/repositories/issuances.js";
import { TransactionRepository } from "../../src/db/repositories/transactions.js";
import {
  deriveTxDeltas,
  holdersInMetaBlob,
  trackedIssuance,
} from "../../src/reconcile/incremental.js";
import type { TrackedIssuance } from "../../src/reconcile/incremental.js";
import { hexToBytes } from "../../src/util/hex.js";

const MPT = "000000011515151515151515151515151515151515151515";
const HOLDER = "rLsf6CoQBcqncszYcxZMzWFDtwng28o5g3";
const TOKEN_HEX = "544F4B454E000000000000000000000000000000";
const ISSUER = "rJ2BeYMXK5zmQSnsRGbL4iqsy9Pw8YVeow";
const PROV = { sourceEndpoint: "wss://clio.example", fetchedAt: "2026-08-12T00:00:00.000Z" };

function encodeMeta(meta: object): Uint8Array {
  return hexToBytes(encode(meta as unknown as Parameters<typeof encode>[0]));
}

// A RippleState (trustline) node placing HOLDER on the high side, ISSUER on low.
function iouMetaBlob(): Uint8Array {
  return encodeMeta({
    TransactionIndex: 0,
    TransactionResult: "tesSUCCESS",
    AffectedNodes: [
      {
        ModifiedNode: {
          LedgerEntryType: "RippleState",
          LedgerIndex: "0".repeat(64),
          FinalFields: {
            Balance: { currency: TOKEN_HEX, issuer: ISSUER, value: "-50" },
            LowLimit: { currency: TOKEN_HEX, issuer: ISSUER, value: "0" },
            HighLimit: { currency: TOKEN_HEX, issuer: HOLDER, value: "1000000" },
            Flags: 0,
          },
        },
      },
    ],
  });
}

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
          FinalFields: {
            Account: HOLDER,
            MPTokenIssuanceID: MPT,
            MPTAmount: String(finalAmt),
            Flags: 0,
          },
          PreviousFields: { MPTAmount: String(prevAmt) },
        },
      },
    ],
  };
  return encodeMeta(meta);
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

describe("holdersInMetaBlob (streaming discovery)", () => {
  const mpt: TrackedIssuance = { id: 1, kind: "mpt", mptIssuanceId: MPT };
  const iou: TrackedIssuance = { id: 2, kind: "iou", currency: "TOKEN", issuer: ISSUER };

  it("extracts an MPT holder from a transaction's meta", () => {
    expect(holdersInMetaBlob(mptMetaBlob(100, 40), [mpt])).toEqual([
      { issuanceId: 1, holder: HOLDER },
    ]);
  });

  it("extracts an IOU holder (the non-issuer side of the trustline)", () => {
    expect(holdersInMetaBlob(iouMetaBlob(), [iou])).toEqual([{ issuanceId: 2, holder: HOLDER }]);
  });

  it("ignores nodes for untracked issuances and empty meta", () => {
    const other: TrackedIssuance = { id: 3, kind: "mpt", mptIssuanceId: `0128${"0".repeat(44)}` };
    expect(holdersInMetaBlob(mptMetaBlob(100, 40), [other])).toEqual([]);
    expect(holdersInMetaBlob(new Uint8Array(), [mpt])).toEqual([]);
  });
});
