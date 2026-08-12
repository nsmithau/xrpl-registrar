import { decode } from "xrpl";

import type { Database, Row } from "../../db/database.js";
import { bytesToHex } from "../../util/hex.js";
import { invalidParams, notInArchive } from "../errors.js";
import type { ScopeRepository } from "../scope.js";
import type { ApiRequest, MethodResult } from "../types.js";

interface TxRow extends Row {
  tx_blob: Uint8Array;
  meta_blob: Uint8Array;
  ledger_index: number | string;
  hash: string;
}

/**
 * Archive-scoped `tx`. Serves a transaction by hash from stored blobs. Absence
 * returns `notInArchive` — never `txnNotFound`, which would falsely assert the
 * transaction does not exist on the ledger.
 */
export async function handleTx(
  db: Database,
  scope: ScopeRepository,
  req: ApiRequest,
): Promise<MethodResult> {
  const hash =
    typeof req.transaction === "string"
      ? req.transaction
      : typeof req.tx_hash === "string"
        ? req.tx_hash
        : undefined;
  if (!hash) return { result: invalidParams("'transaction' (a transaction hash) is required") };

  const { rows } = await db.query<TxRow>(
    "SELECT tx_blob, meta_blob, ledger_index, hash FROM transactions WHERE hash = $1",
    [hash],
  );
  if (rows.length === 0) {
    return { result: notInArchive(`Transaction ${hash}`, await scope.summarize()) };
  }

  const r = rows[0]!;
  const binary = req.binary === true;
  const result: Record<string, unknown> = binary
    ? {
        status: "success",
        tx_blob: bytesToHex(r.tx_blob),
        meta_blob: bytesToHex(r.meta_blob),
        hash: r.hash,
        ledger_index: Number(r.ledger_index),
        validated: true,
      }
    : {
        status: "success",
        tx_json: decode(bytesToHex(r.tx_blob)) as Record<string, unknown>,
        meta: decode(bytesToHex(r.meta_blob)) as Record<string, unknown>,
        hash: r.hash,
        ledger_index: Number(r.ledger_index),
        validated: true,
      };

  return { result };
}
