import type { Database } from "../db/database.js";
import { insertTransactionRows, type IngestTransaction } from "../db/repositories/transactions.js";
import { nullLogger, type Logger } from "../logging/logger.js";

import { GapTracker } from "./gapTracker.js";
import type { LedgerRange, TailSource, TransactionEvent } from "./types.js";

export interface LiveTailOptions {
  readonly db: Database;
  readonly source: TailSource;
  /** Anchor the gap tracker at a known-complete ledger (backfill high-water). */
  readonly startLedger?: number;
  /** Heal a detected gap. Default: log only. */
  readonly onGap?: (range: LedgerRange) => Promise<void> | void;
  readonly logger?: Logger;
}

export interface LiveTailStats {
  readonly ingested: number;
  readonly gaps: number;
  readonly lastContiguousLedger: number | null;
}

function eventToIngest(ev: TransactionEvent): IngestTransaction {
  return {
    hash: ev.hash,
    ledgerIndex: ev.ledgerIndex,
    txType: ev.txType,
    mptIssuanceId: null,
    txBlob: ev.txBlob,
    metaBlob: ev.metaBlob,
    provenance: ev.provenance,
    accounts: ev.accounts,
  };
}

/**
 * Keeps the archive current after backfill.
 *
 * Consumes a stream of tail events: validated transactions are ingested
 * (idempotently), and the validated-ledger sequence is watched for gaps. A gap
 * means ledgers — and any in-scope transactions in them — were missed, so it is
 * handed to `onGap` to heal. Ingest and gap-fill are both idempotent, so a
 * transaction seen live and then again during a heal is stored once.
 */
export class LiveTail {
  readonly #db: Database;
  readonly #source: TailSource;
  readonly #gaps: GapTracker;
  readonly #onGap: (range: LedgerRange) => Promise<void> | void;
  readonly #logger: Logger;

  #running = false;
  #ingested = 0;
  #gapCount = 0;

  constructor(options: LiveTailOptions) {
    this.#db = options.db;
    this.#source = options.source;
    this.#gaps = new GapTracker(options.startLedger);
    this.#onGap = options.onGap ?? (() => {});
    this.#logger = options.logger ?? nullLogger;
  }

  /** Run until the source ends or `stop()` is called. */
  async run(): Promise<void> {
    this.#running = true;
    for await (const ev of this.#source.events()) {
      if (!this.#running) break;
      if (ev.type === "ledger") {
        const gap = this.#gaps.observe(ev.ledgerIndex);
        if (gap) {
          this.#gapCount += 1;
          this.#logger.warn("ledger gap detected", { ...gap });
          await this.#onGap(gap);
        }
      } else {
        await this.#db.transaction((t) => insertTransactionRows(t, eventToIngest(ev)));
        this.#ingested += 1;
      }
    }
  }

  stop(): void {
    this.#running = false;
  }

  stats(): LiveTailStats {
    return {
      ingested: this.#ingested,
      gaps: this.#gapCount,
      lastContiguousLedger: this.#gaps.lastContiguous,
    };
  }
}
