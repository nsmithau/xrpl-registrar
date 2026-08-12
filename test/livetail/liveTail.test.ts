import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openArchiveDatabase, type Database } from "../../src/db/index.js";
import { LiveTail } from "../../src/livetail/liveTail.js";
import type { LedgerRange, TailEvent, TailSource, TransactionEvent } from "../../src/livetail/types.js";

const PROV = { sourceEndpoint: "wss://clio.example", fetchedAt: "2026-08-12T00:00:00.000Z" };

function tx(hash: string, ledgerIndex: number, accounts: string[]): TransactionEvent {
  return {
    type: "transaction",
    hash,
    ledgerIndex,
    txType: "Payment",
    accounts,
    txBlob: new Uint8Array([1]),
    metaBlob: new Uint8Array([2]),
    provenance: PROV,
  };
}

function source(events: TailEvent[]): TailSource {
  return {
    events: async function* () {
      for (const e of events) yield e;
    },
    close: () => Promise.resolve(),
  };
}

async function count(db: Database, table: string): Promise<number> {
  const { rows } = await db.query<{ n: number | string }>(`SELECT count(*)::bigint AS n FROM ${table}`);
  return Number(rows[0]!.n);
}

describe("LiveTail", () => {
  let db: Database;

  beforeEach(async () => {
    db = await openArchiveDatabase();
  });

  afterEach(async () => {
    await db.close();
  });

  it("ingests in-scope transactions and heals detected ledger gaps", async () => {
    const gaps: LedgerRange[] = [];
    const events: TailEvent[] = [
      { type: "ledger", ledgerIndex: 100 },
      tx("T1", 100, ["rA"]),
      { type: "ledger", ledgerIndex: 101 },
      { type: "ledger", ledgerIndex: 104 }, // gap 102-103
      tx("T2", 104, ["rA", "rB"]),
    ];

    const tail = new LiveTail({
      db,
      source: source(events),
      startLedger: 99,
      onGap: (range) => {
        gaps.push(range);
      },
    });
    await tail.run();

    expect(await count(db, "transactions")).toBe(2);
    expect(await count(db, "account_transactions")).toBe(3); // T1→rA, T2→rA, T2→rB
    expect(gaps).toEqual([{ fromLedger: 102, toLedger: 103 }]);

    const stats = tail.stats();
    expect(stats.ingested).toBe(2);
    expect(stats.gaps).toBe(1);
    expect(stats.lastContiguousLedger).toBe(104);
  });

  it("is idempotent when the same transaction is seen twice (live then heal)", async () => {
    const tail = new LiveTail({
      db,
      source: source([tx("DUP", 100, ["rA"]), tx("DUP", 100, ["rA"])]),
    });
    await tail.run();
    expect(await count(db, "transactions")).toBe(1);
    expect(tail.stats().ingested).toBe(2); // saw two, stored one
  });
});
