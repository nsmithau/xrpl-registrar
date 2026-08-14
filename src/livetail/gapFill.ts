import { mapBinaryEntry } from "../backfill/mapEntry.js";
import { accountTxPages, type BinaryTxEntry } from "../backfill/pages.js";
import type { Provenance } from "../clio/types.js";
import type { Database, Queryable } from "../db/database.js";
import { insertTransactionRows, type IngestTransaction } from "../db/repositories/transactions.js";
import type { ClioReader } from "../discovery/types.js";
import { nullLogger, type Logger } from "../logging/logger.js";

import type { LedgerRange } from "./types.js";

/** Emit a running progress counter at most every this many transactions. */
const HEAL_PROGRESS_EVERY = 1000;

export interface BackfillGapOptions {
  readonly logger?: Logger;
  /** Derive a transaction's balance deltas as it is ingested, on the same DB
   * transaction as the insert. Default: none. */
  readonly deriveDeltas?: (q: Queryable, hash: string, metaBlob: Uint8Array) => Promise<void>;
  /** Called per ingested transaction (post-commit) — used to run streaming
   * discovery over healed transactions, so a holder that first appeared during
   * the gap is caught here rather than only by the periodic safety-net scan. */
  readonly onEntry?: (metaBlob: Uint8Array) => void;
  /** Override the entry→row mapping (defaults to decoding raw binary blobs). */
  readonly mapEntry?: (entry: BinaryTxEntry, account: string, provenance: Provenance) => IngestTransaction;
}

/**
 * Heal a detected gap by re-fetching a bounded ledger range for the in-scope
 * accounts and ingesting it. Reuses the backfill pager and idempotent ingest,
 * so re-filling an overlapping range never duplicates. Returns the number of
 * transactions ingested (including no-op re-inserts).
 *
 * A gap heal can take a while (one paged `account_tx` sweep per account), during
 * which the live tail is blocked, so it logs a start line, a throttled running
 * counter, and a completion line — otherwise a large heal looks like a stall.
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
  const mapEntry = options.mapEntry ?? mapBinaryEntry;

  const startedMs = Date.now();
  logger.info("gap heal started", {
    fromLedger: range.fromLedger,
    toLedger: range.toLedger,
    accounts: accounts.length,
  });
  let count = 0;
  let lastLogged = 0;
  for (const account of accounts) {
    for await (const page of accountTxPages(client, {
      account,
      fromLedger: range.fromLedger,
      toLedger: range.toLedger,
    })) {
      if (page.entries.length === 0) continue;
      const mapped = page.entries.map((entry) => mapEntry(entry, account, page.provenance));
      await db.transaction(async (t) => {
        for (const m of mapped) {
          await insertTransactionRows(t, m);
          await deriveDeltas(t, m.hash, m.metaBlob);
          count += 1;
        }
      });
      // Post-commit: streaming discovery over the healed transactions.
      for (const m of mapped) onEntry(m.metaBlob);
      // A single running counter, throttled — not a line per account or page.
      if (count - lastLogged >= HEAL_PROGRESS_EVERY) {
        lastLogged = count;
        logger.info("gap heal progress", { ingested: count });
      }
    }
  }
  logger.info("gap heal finished", {
    fromLedger: range.fromLedger,
    toLedger: range.toLedger,
    ingested: count,
    elapsedMs: Date.now() - startedMs,
  });
  return count;
}
