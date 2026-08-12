import { decode, hashes } from "xrpl";

import type { Provenance } from "../clio/types.js";
import type { IngestTransaction } from "../db/repositories/transactions.js";
import { hexToBytes } from "../util/hex.js";

import type { BinaryTxEntry } from "./pages.js";

/**
 * Map a raw binary `account_tx` entry into an ingestable transaction.
 *
 * Binary responses carry no `hash` or `TransactionType`, so both are derived
 * from the blob: the hash via the standard signed-transaction hashing, the type
 * by decoding. The raw blobs are retained verbatim so everything is
 * re-derivable from source.
 */
export function mapBinaryEntry(
  entry: BinaryTxEntry,
  account: string,
  provenance: Provenance,
): IngestTransaction {
  const decoded = decode(entry.tx_blob) as { TransactionType?: string };
  return {
    hash: hashes.hashSignedTx(entry.tx_blob),
    ledgerIndex: entry.ledger_index,
    txType: decoded.TransactionType ?? "unknown",
    mptIssuanceId: null,
    txBlob: hexToBytes(entry.tx_blob),
    metaBlob: hexToBytes(entry.meta_blob),
    provenance,
    accounts: [account],
  };
}
