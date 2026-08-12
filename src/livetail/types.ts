import type { Provenance } from "../clio/types.js";

/** A newly validated ledger, from the `ledger` subscription stream. */
export interface LedgerEvent {
  readonly type: "ledger";
  readonly ledgerIndex: number;
}

/** A validated transaction touching one or more in-scope accounts. */
export interface TransactionEvent {
  readonly type: "transaction";
  readonly hash: string;
  readonly ledgerIndex: number;
  readonly txType: string;
  /** In-scope accounts this transaction touches. */
  readonly accounts: string[];
  readonly txBlob: Uint8Array;
  readonly metaBlob: Uint8Array;
  readonly provenance: Provenance;
}

export type TailEvent = LedgerEvent | TransactionEvent;

/** A source of live tail events — the seam that keeps the engine testable
 * without a socket. */
export interface TailSource {
  events(): AsyncIterable<TailEvent>;
  close(): Promise<void>;
}

/** An inclusive ledger range. */
export interface LedgerRange {
  readonly fromLedger: number;
  readonly toLedger: number;
}
