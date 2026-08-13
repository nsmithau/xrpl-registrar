import type { Database, Row } from "../db/database.js";
import { LedgerTimeRepository } from "../db/repositories/ledgers.js";
import { asRecord, asString } from "../discovery/fields.js";
import type { ClioReader } from "../discovery/types.js";

interface LedgerRow extends Row {
  ledger_index: number | string;
}

/**
 * Capture close times for the ledgers an issuance's archived transactions live
 * in, so balances can later be reported by time. Fetches only ledgers not
 * already recorded, via the `ledger` command (answered locally by Clio), and
 * persists them. Idempotent. Returns the number of ledgers captured.
 */
export async function captureCloseTimes(
  client: ClioReader,
  db: Database,
  issuanceId: number,
): Promise<number> {
  const { rows } = await db.query<LedgerRow>(
    `SELECT DISTINCT t.ledger_index
     FROM transactions t
     JOIN account_transactions at ON at.hash = t.hash
     JOIN account_issuance ai ON ai.address = at.address
     LEFT JOIN ledgers l ON l.ledger_index = t.ledger_index
     WHERE ai.issuance_id = $1 AND l.ledger_index IS NULL
     ORDER BY t.ledger_index`,
    [issuanceId],
  );

  const ledgers = new LedgerTimeRepository(db);
  let captured = 0;
  for (const row of rows) {
    const ledgerIndex = Number(row.ledger_index);
    const res = await client.request<{ ledger?: unknown }>({
      command: "ledger",
      ledger_index: ledgerIndex,
    });
    const closeTimeIso = asString(asRecord(res.result.ledger)?.["close_time_iso"]);
    if (closeTimeIso) {
      await ledgers.record({ ledgerIndex, closeTimeIso });
      captured += 1;
    }
  }
  return captured;
}
