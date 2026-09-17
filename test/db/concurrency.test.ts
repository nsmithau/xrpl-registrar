/**
 * Concurrent writers against a real server.
 *
 * On PGlite every statement is serialised on one thread, so none of this can
 * be observed there — which is exactly why it needs testing here. The backfill
 * worker runs four concurrent account loops and the gap heal four concurrent
 * issuer sweeps, all upserting overlapping rows in `accounts`, `transactions`
 * and `balance_deltas`. Two of them taking the same row locks in opposite
 * orders is how a deadlock happens.
 *
 * Every "no deadlock" assertion here is paired with a control that *does*
 * deadlock. Without one, a green result would be indistinguishable from a test
 * that never contended at all.
 *
 * Skipped unless TEST_DATABASE_URL is set — `pnpm test:pg`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database, Queryable } from "../../src/db/database.js";
import { insertTransactionRowsMany } from "../../src/db/repositories/transactions.js";
import { insertDeltasMany } from "../../src/reconcile/balanceDeltas.js";
import { openTestDatabase, usingPostgres } from "../dbHelpers.js";

const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** How long a transaction sits on its locks, to make an overlap with another
 * writer near-certain where a barrier cannot be used. */
const HOLD_LOCKS_MS = 250;

/**
 * A rendezvous: every party waits until all of them have arrived.
 *
 * Interleaving cannot be arranged with a sleep. Under a loaded machine — the
 * whole suite running in parallel workers — one transaction can acquire its
 * connection, run its statement and commit before the other has even started,
 * so the two never overlap and a deadlock test silently passes without ever
 * contending. Blocking until both have taken their first lock makes the
 * contention deterministic regardless of load.
 *
 * Released permanently once tripped, so a transaction the driver retries
 * passes straight through rather than waiting for a partner that has already
 * finished. Capped by a timeout so a party that never arrives fails the test
 * rather than hanging it.
 */
function rendezvous(parties: number, timeoutMs = 10_000): () => Promise<void> {
  let arrived = 0;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  return async () => {
    arrived += 1;
    if (arrived >= parties) open();
    await Promise.race([gate, pause(timeoutMs)]);
  };
}

const entry = (hash: string, accounts: readonly string[], ledger = 100) => ({
  hash,
  ledgerIndex: ledger,
  txType: "Payment",
  txBlob: new Uint8Array([1]),
  metaBlob: new Uint8Array([2]),
  provenance: { sourceEndpoint: "wss://clio.test", fetchedAt: new Date().toISOString() },
  accounts: [...accounts],
});

/** The `accounts` upsert the ingest path performs, issued directly so a test
 * can choose the lock order the repository would otherwise impose. */
async function touchAccount(q: Queryable, address: string): Promise<void> {
  await q.query(
    `INSERT INTO accounts (address, first_seen_ledger) VALUES ($1, 5)
     ON CONFLICT (address) DO UPDATE
       SET first_seen_ledger = LEAST(accounts.first_seen_ledger, EXCLUDED.first_seen_ledger)`,
    [address],
  );
}

describe.skipIf(!usingPostgres)("concurrent writers", () => {
  let db: Database;

  beforeEach(async () => {
    db = await openTestDatabase();
    await db.query("INSERT INTO accounts (address, first_seen_ledger) VALUES ('rA', 9), ('rB', 9)");
  });

  afterEach(async () => {
    await db.close();
  });

  // The control. If this ever stops deadlocking, the test below proves nothing
  // and the pair needs rethinking rather than deleting.
  it("deadlocks when two transactions lock the same rows in opposite orders", async () => {
    let bodies = 0;
    const bothHoldFirstLock = rendezvous(2);
    const opposing = (first: string, second: string): Promise<void> =>
      db.transaction(async (t) => {
        bodies += 1;
        await touchAccount(t, first);
        await bothHoldFirstLock();
        await touchAccount(t, second);
      });

    await Promise.all([opposing("rA", "rB"), opposing("rB", "rA")]);

    // Postgres kills one transaction; the driver retries it, so the body runs
    // more than once per caller and both callers still resolve.
    expect(bodies).toBeGreaterThan(2);
  });

  it("does not deadlock when the batch writer orders its rows", async () => {
    let bodies = 0;
    // The same two accounts fed in opposite orders, which is what deadlocked
    // the control. Deliberately *not* using the rendezvous here: because the
    // repository sorts, both transactions reach for `rA` first, so the second
    // blocks on the first immediately and could never arrive at a barrier.
    // That blocking is the contention — it resolves by waiting, which is the
    // whole point. Holding the locks across a pause makes sure the overlap is
    // real rather than the two happening to run end to end.
    const viaRepository = (accounts: string[], hash: string): Promise<void> =>
      db.transaction(async (t) => {
        bodies += 1;
        await insertTransactionRowsMany(t, [entry(hash, accounts)]);
        await pause(HOLD_LOCKS_MS);
        await insertTransactionRowsMany(t, [entry(`${hash}b`, accounts)]);
      });

    await Promise.all([viaRepository(["rA", "rB"], "S1"), viaRepository(["rB", "rA"], "S2")]);

    // One retry would push this past 2; serialised-but-not-deadlocked is 2.
    expect(bodies).toBe(2);
  });

  it("ingests overlapping pages from many writers without loss or duplication", async () => {
    const hashes = Array.from({ length: 40 }, (_, i) => `H${String(i).padStart(3, "0")}`);
    const accounts = Array.from({ length: 12 }, (_, i) => `r${String(i).padStart(3, "0")}`);

    // Six writers ingesting the *same* page, each feeding it in a different
    // order — the shape a resumed backfill and a gap heal produce together.
    await Promise.all(
      [1, 2, 3, 4, 5, 6].map((seed) =>
        db.transaction((t) =>
          insertTransactionRowsMany(
            t,
            [...hashes]
              .sort((a, b) => ((a.charCodeAt(2) * seed) % 7) - ((b.charCodeAt(2) * seed) % 7))
              .map((h) =>
                entry(h, seed % 2 === 0 ? accounts : [...accounts].reverse(), 200 + seed),
              ),
          ),
        ),
      ),
    );

    const count = async (sql: string): Promise<number> =>
      Number((await db.query<{ n: number }>(sql)).rows[0]!.n);
    expect(await count("SELECT count(*)::bigint AS n FROM transactions WHERE hash LIKE 'H%'")).toBe(
      40,
    );
    expect(
      await count("SELECT count(*)::bigint AS n FROM account_transactions WHERE hash LIKE 'H%'"),
    ).toBe(40 * 12);
  });

  it("upserts deltas from concurrent derivers exactly once each", async () => {
    await db.query("INSERT INTO issuances (kind, mpt_issuance_id) VALUES ('mpt', 'MPT1')");
    const { rows: iss } = await db.query<{ id: number }>("SELECT id FROM issuances");
    const issuanceId = iss[0]!.id;

    const hashes = Array.from({ length: 20 }, (_, i) => `D${String(i).padStart(3, "0")}`);
    const accounts = Array.from({ length: 12 }, (_, i) => `r${String(i).padStart(3, "0")}`);
    await db.transaction((t) =>
      insertTransactionRowsMany(
        t,
        hashes.map((h) => entry(h, accounts)),
      ),
    );

    await Promise.all(
      [1, 2, 3, 4].map((seed) =>
        db.transaction((t) =>
          insertDeltasMany(
            t,
            issuanceId,
            hashes.flatMap((h) =>
              (seed % 2 === 0 ? accounts : [...accounts].reverse()).map((a) => ({
                hash: h,
                address: a,
                delta: BigInt(seed),
              })),
            ),
          ),
        ),
      ),
    );

    const { rows } = await db.query<{ n: number }>(
      "SELECT count(*)::bigint AS n FROM balance_deltas WHERE issuance_id = $1",
      [issuanceId],
    );
    expect(Number(rows[0]!.n)).toBe(20 * 12);
  });
});
