import type { Provenance } from "../clio/types.js";
import { accountTxPages, type BinaryTxEntry } from "../backfill/pages.js";
import { issuerSweepEntryMapper, type MappedEntry } from "../backfill/issuerSweep.js";
import type { Database } from "../db/database.js";
import { insertTransactionRowsMany } from "../db/repositories/transactions.js";
import type { ClioReader } from "../discovery/types.js";
import { nullLogger, type Logger } from "../logging/logger.js";
import { type DecodedMeta, type DeriveDeltas, type TrackedIssuance } from "../reconcile/incremental.js";

import type { LedgerRange } from "./types.js";

/** Emit a running progress counter at most every this many transactions. */
const HEAL_PROGRESS_EVERY = 1000;

/** How many issuer sweeps to run concurrently (usually there is a single issuer,
 * so this rarely binds). The global governor still caps actual upstream load. */
const HEAL_CONCURRENCY = 4;

export interface BackfillGapOptions {
  readonly logger?: Logger;
  /** Derive a transaction's balance deltas as it is ingested, on the same DB
   * transaction as the insert. Default: none. */
  readonly deriveDeltas?: DeriveDeltas;
  /** Called per ingested transaction (post-commit) with its already-decoded
   * metadata — runs streaming discovery over healed transactions, so a holder
   * that first appeared during the gap is recorded and its pre-gap history
   * backfilled, rather than waiting for the periodic safety-net scan. */
  readonly onEntry?: (meta: DecodedMeta) => void;
  /** How many issuer sweeps to run concurrently (default 4). */
  readonly concurrency?: number;
  /** `account_tx` page size requested from upstream. */
  readonly pageLimit?: number;
  /** Override the entry → row mapping (defaults to decoding binary blobs and
   * scoping to tracked-issuance holders). Injectable for tests. */
  readonly mapEntry?: (entry: BinaryTxEntry, issuer: string, provenance: Provenance) => MappedEntry | null;
}

/**
 * Heal a detected gap by re-fetching the missed transactions and ingesting the
 * ones that touch a tracked issuance. Rather than a request per gap **ledger**,
 * it pages `account_tx` on each **issuer** over the gap range — one bounded,
 * paginated sweep captures every holder and every issuance on that issuer,
 * because Clio indexes MPT/IOU activity (including holder-to-holder payments)
 * against the issuer. So the cost is O(in-scope transactions in the gap), not
 * O(gap ledgers) and not O(holders): three MPTs on one issuer heal in a single
 * paginated sweep. Reuses idempotent ingest, so an overlapping re-heal never
 * duplicates. Returns the number of transactions ingested.
 *
 * The tail is blocked during a heal, so it logs a start line, a throttled
 * running counter, and a completion line — otherwise a large heal looks stalled.
 */
export async function backfillGap(
  client: ClioReader,
  db: Database,
  issuers: readonly string[],
  range: LedgerRange,
  tracked: readonly TrackedIssuance[],
  options: BackfillGapOptions = {},
): Promise<number> {
  const logger = options.logger ?? nullLogger;
  const deriveDeltas = options.deriveDeltas ?? (() => Promise.resolve());
  const onEntry = options.onEntry ?? (() => {});
  const mapEntry = options.mapEntry ?? issuerSweepEntryMapper(tracked);
  const concurrency = options.concurrency ?? HEAL_CONCURRENCY;

  const startedMs = Date.now();
  logger.info("gap heal started", {
    fromLedger: range.fromLedger,
    toLedger: range.toLedger,
    ledgers: range.toLedger - range.fromLedger + 1,
    issuers: issuers.length,
  });
  let count = 0;
  let lastLogged = 0;

  const sweepIssuer = async (issuer: string): Promise<void> => {
    for await (const page of accountTxPages(client, {
      account: issuer,
      fromLedger: range.fromLedger,
      toLedger: range.toLedger,
      limit: options.pageLimit,
    })) {
      const batch: MappedEntry[] = [];
      for (const entry of page.entries) {
        const mapped = mapEntry(entry, issuer, page.provenance);
        if (mapped) batch.push(mapped);
      }
      if (batch.length === 0) continue;

      await db.transaction(async (t) => {
        await insertTransactionRowsMany(t, batch.map((b) => b.row));
        for (const b of batch) {
          await deriveDeltas(t, b.row.hash, b.meta);
          count += 1;
        }
      });
      // Post-commit: streaming discovery over the healed transactions.
      for (const b of batch) onEntry(b.meta);
      if (count - lastLogged >= HEAL_PROGRESS_EVERY) {
        lastLogged = count;
        logger.info("gap heal progress", { ingested: count });
      }
    }
  };

  await mapPool(issuers, Math.max(1, concurrency), sweepIssuer);

  logger.info("gap heal finished", {
    fromLedger: range.fromLedger,
    toLedger: range.toLedger,
    ingested: count,
    elapsedMs: Date.now() - startedMs,
  });
  return count;
}

/** Run `fn` over `items` with at most `concurrency` in flight at once. */
async function mapPool<T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (next < items.length) {
      await fn(items[next++]!);
    }
  });
  await Promise.all(runners);
}
