import { decode, hashes } from "xrpl";

import type { Provenance } from "../clio/types.js";
import { accountTxPages, type BinaryTxEntry } from "../backfill/pages.js";
import type { Database, Queryable } from "../db/database.js";
import { asRecord } from "../discovery/fields.js";
import { insertTransactionRowsMany, type IngestTransaction } from "../db/repositories/transactions.js";
import type { ClioReader } from "../discovery/types.js";
import { nullLogger, type Logger } from "../logging/logger.js";
import { holdersInMeta, type TrackedIssuance } from "../reconcile/incremental.js";
import { hexToBytes } from "../util/hex.js";

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
  readonly deriveDeltas?: (q: Queryable, hash: string, metaBlob: Uint8Array) => Promise<void>;
  /** Called per ingested transaction (post-commit) — runs streaming discovery
   * over healed transactions, so a holder that first appeared during the gap is
   * recorded and its pre-gap history backfilled, rather than waiting for the
   * periodic safety-net scan. */
  readonly onEntry?: (metaBlob: Uint8Array) => void;
  /** How many issuer sweeps to run concurrently (default 4). */
  readonly concurrency?: number;
  /** `account_tx` page size requested from upstream. */
  readonly pageLimit?: number;
  /** Override the entry → row mapping (defaults to decoding binary blobs and
   * scoping to tracked-issuance holders). Injectable for tests. */
  readonly mapEntry?: (entry: BinaryTxEntry, issuer: string, provenance: Provenance) => IngestTransaction | null;
}

/** Decode a binary `account_tx` entry and keep it only if it touches a holder of
 * a tracked issuance. Every relevant transaction on an MPT (or IOU) — including
 * holder-to-holder payments where the issuer's own AccountRoot is untouched —
 * appears in the issuer's `account_tx` and modifies a holder's `MPToken` /
 * `RippleState` node, so `holdersInMeta` is a complete in-scope filter. The
 * transaction is associated with the issuer (mirroring Clio's own index) plus
 * every tracked-issuance holder it touches. */
function makeMapEntry(
  tracked: readonly TrackedIssuance[],
): (entry: BinaryTxEntry, issuer: string, provenance: Provenance) => IngestTransaction | null {
  return (entry, issuer, provenance) => {
    const meta = asRecord(decode(entry.meta_blob));
    const holders = meta ? holdersInMeta(meta, tracked) : [];
    if (holders.length === 0) return null; // the issuer's unrelated / off-scope activity
    const tx = decode(entry.tx_blob) as { TransactionType?: string };
    return {
      hash: hashes.hashSignedTx(entry.tx_blob),
      ledgerIndex: entry.ledger_index,
      txType: tx.TransactionType ?? "unknown",
      mptIssuanceId: null,
      txBlob: hexToBytes(entry.tx_blob),
      metaBlob: hexToBytes(entry.meta_blob),
      provenance,
      accounts: [...new Set([issuer, ...holders.map((h) => h.holder)])],
    };
  };
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
  const mapEntry = options.mapEntry ?? makeMapEntry(tracked);
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
      const rows: IngestTransaction[] = [];
      for (const entry of page.entries) {
        const mapped = mapEntry(entry, issuer, page.provenance);
        if (mapped) rows.push(mapped);
      }
      if (rows.length === 0) continue;

      await db.transaction(async (t) => {
        await insertTransactionRowsMany(t, rows);
        for (const row of rows) {
          await deriveDeltas(t, row.hash, row.metaBlob);
          count += 1;
        }
      });
      // Post-commit: streaming discovery over the healed transactions.
      for (const row of rows) onEntry(row.metaBlob);
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
