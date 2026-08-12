import { mapBinaryEntry } from "../backfill/mapEntry.js";
import { accountTxPages } from "../backfill/pages.js";
import type { Database } from "../db/database.js";
import { insertTransactionRows } from "../db/repositories/transactions.js";
import type { ClioReader } from "../discovery/types.js";

import type { LedgerRange } from "./types.js";

/**
 * Heal a detected gap by re-fetching a bounded ledger range for the in-scope
 * accounts and ingesting it. Reuses the backfill pager and idempotent ingest,
 * so re-filling an overlapping range never duplicates. Returns the number of
 * transactions ingested (including no-op re-inserts).
 */
export async function backfillGap(
  client: ClioReader,
  db: Database,
  accounts: readonly string[],
  range: LedgerRange,
): Promise<number> {
  let count = 0;
  for (const account of accounts) {
    for await (const page of accountTxPages(client, {
      account,
      fromLedger: range.fromLedger,
      toLedger: range.toLedger,
    })) {
      if (page.entries.length === 0) continue;
      await db.transaction(async (t) => {
        for (const entry of page.entries) {
          await insertTransactionRows(t, mapBinaryEntry(entry, account, page.provenance));
          count += 1;
        }
      });
    }
  }
  return count;
}
