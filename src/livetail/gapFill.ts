import { mapBinaryEntry } from "../backfill/mapEntry.js";
import { accountTxPages } from "../backfill/pages.js";
import type { Database, Queryable } from "../db/database.js";
import { insertTransactionRows } from "../db/repositories/transactions.js";
import type { ClioReader } from "../discovery/types.js";
import { nullLogger, type Logger } from "../logging/logger.js";

import type { LedgerRange } from "./types.js";

/** Emit a running progress counter at most every this many transactions. */
const HEAL_PROGRESS_EVERY = 1000;

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
  logger: Logger = nullLogger,
  deriveDeltas: (q: Queryable, hash: string, metaBlob: Uint8Array) => Promise<void> = () => Promise.resolve(),
): Promise<number> {
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
      await db.transaction(async (t) => {
        for (const entry of page.entries) {
          const mapped = mapBinaryEntry(entry, account, page.provenance);
          await insertTransactionRows(t, mapped);
          await deriveDeltas(t, mapped.hash, mapped.metaBlob);
          count += 1;
        }
      });
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
