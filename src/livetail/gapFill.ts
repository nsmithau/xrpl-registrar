import { decode, hashes } from "xrpl";

import type { Provenance } from "../clio/types.js";
import type { Database, Queryable } from "../db/database.js";
import { asString } from "../discovery/fields.js";
import { insertTransactionRowsMany, type IngestTransaction } from "../db/repositories/transactions.js";
import type { ClioReader } from "../discovery/types.js";
import { nullLogger, type Logger } from "../logging/logger.js";
import { hexToBytes } from "../util/hex.js";

import { affectedAccounts } from "./affected.js";
import type { LedgerRange } from "./types.js";

/** Emit a running progress counter at most every this many transactions. */
const HEAL_PROGRESS_EVERY = 1000;

/** How many gap ledgers to fetch concurrently. The global governor still caps
 * actual upstream requests, so this just keeps its slots fed. */
const HEAL_CONCURRENCY = 8;

/** A binary transaction in a `ledger` response (transactions + expand + binary). */
interface LedgerTxEntry {
  readonly tx_blob?: string;
  readonly meta_blob?: string;
  readonly hash?: string;
}

export interface BackfillGapOptions {
  readonly logger?: Logger;
  /** Derive a transaction's balance deltas as it is ingested, on the same DB
   * transaction as the insert. Default: none. */
  readonly deriveDeltas?: (q: Queryable, hash: string, metaBlob: Uint8Array) => Promise<void>;
  /** Called per ingested transaction (post-commit) — used to run streaming
   * discovery over healed transactions, so a holder that first appeared during
   * the gap is caught here rather than only by the periodic safety-net scan. */
  readonly onEntry?: (metaBlob: Uint8Array) => void;
  /** How many gap ledgers to fetch concurrently (default 8). */
  readonly concurrency?: number;
  /** Override the ledger-entry → row mapping (defaults to decoding raw blobs and
   * scope-filtering). Injectable for tests. */
  readonly mapTx?: (
    entry: LedgerTxEntry,
    ledgerIndex: number,
    provenance: Provenance,
    scope: ReadonlySet<string>,
  ) => IngestTransaction | null;
}

/** Decode a ledger's binary transaction and keep it only if it touches an
 * in-scope account. */
function defaultMapTx(
  entry: LedgerTxEntry,
  ledgerIndex: number,
  provenance: Provenance,
  scope: ReadonlySet<string>,
): IngestTransaction | null {
  if (!entry.tx_blob || !entry.meta_blob) return null;
  const tx = decode(entry.tx_blob) as { TransactionType?: string };
  const touched = affectedAccounts(tx, decode(entry.meta_blob), scope);
  if (touched.length === 0) return null;
  return {
    hash: asString(entry.hash) ?? hashes.hashSignedTx(entry.tx_blob),
    ledgerIndex,
    txType: tx.TransactionType ?? "unknown",
    mptIssuanceId: null,
    txBlob: hexToBytes(entry.tx_blob),
    metaBlob: hexToBytes(entry.meta_blob),
    provenance,
    accounts: touched,
  };
}

/**
 * Heal a detected gap by re-fetching the missed **ledgers** and ingesting the
 * transactions in them that touch an in-scope account. Reuses idempotent
 * ingest, so re-filling an overlapping range never duplicates.
 *
 * This is O(gap ledgers), not O(in-scope accounts): a small reconnection gap
 * costs a handful of `ledger` fetches regardless of whether the archive tracks
 * ten accounts or ten thousand — the previous per-account `account_tx` sweep
 * issued one request per account (mostly empty) for every gap. Returns the
 * number of transactions ingested (including no-op re-inserts).
 *
 * The tail is blocked during a heal, so it logs a start line, a throttled
 * running counter, and a completion line — otherwise a large heal looks stalled.
 */
export async function backfillGap(
  client: ClioReader,
  db: Database,
  accounts: readonly string[],
  range: LedgerRange,
  options: BackfillGapOptions = {},
): Promise<number> {
  const logger = options.logger ?? nullLogger;
  const deriveDeltas = options.deriveDeltas ?? (() => Promise.resolve());
  const onEntry = options.onEntry ?? (() => {});
  const mapTx = options.mapTx ?? defaultMapTx;
  const concurrency = options.concurrency ?? HEAL_CONCURRENCY;
  const scope = new Set(accounts);

  const startedMs = Date.now();
  logger.info("gap heal started", {
    fromLedger: range.fromLedger,
    toLedger: range.toLedger,
    ledgers: range.toLedger - range.fromLedger + 1,
    accounts: scope.size,
  });
  let count = 0;
  let lastLogged = 0;

  const healLedger = async (ledgerIndex: number): Promise<void> => {
    const res = await client.request<{ ledger?: { transactions?: LedgerTxEntry[] } }>({
      command: "ledger",
      ledger_index: ledgerIndex,
      transactions: true,
      expand: true,
      binary: true,
    });
    const rows: IngestTransaction[] = [];
    for (const entry of res.result.ledger?.transactions ?? []) {
      const mapped = mapTx(entry, ledgerIndex, res.provenance, scope);
      if (mapped) rows.push(mapped);
    }
    if (rows.length === 0) return;

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
  };

  const ledgers: number[] = [];
  for (let l = range.fromLedger; l <= range.toLedger; l += 1) ledgers.push(l);
  // Fetch ledgers with bounded concurrency instead of one at a time; the global
  // governor still caps actual upstream requests. Ingest is idempotent, so the
  // (nondeterministic) completion order is fine.
  await mapPool(ledgers, concurrency, healLedger);

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
