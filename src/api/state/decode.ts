import { decode } from "xrpl";

import type { Row } from "../../db/database.js";
import { asRecord } from "../../discovery/fields.js";
import { bytesToHex } from "../../util/hex.js";

import type { MetaEntry } from "./reconstruct.js";

export interface MetaRow extends Row {
  meta_blob: Uint8Array;
  ledger_index: number | string;
}

function transactionIndex(meta: Record<string, unknown>): number {
  const value = meta["TransactionIndex"];
  return typeof value === "number" ? value : 0;
}

/** Decode stored `meta_blob`s into reconstruction entries. */
export function decodeMetaEntries(rows: readonly MetaRow[]): MetaEntry[] {
  const entries: MetaEntry[] = [];
  for (const row of rows) {
    const meta = asRecord(decode(bytesToHex(row.meta_blob)));
    if (!meta) continue;
    entries.push({
      ledgerIndex: Number(row.ledger_index),
      transactionIndex: transactionIndex(meta),
      meta,
    });
  }
  return entries;
}
