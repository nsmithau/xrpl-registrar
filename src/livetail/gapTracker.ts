import type { LedgerRange } from "./types.js";

/**
 * Tracks contiguous ledger progress and detects gaps in the validated ledger
 * sequence.
 *
 * The `ledger` stream should deliver every validated ledger in order. If it
 * skips — a reconnect, a dropped message — then some ledgers were never
 * observed and any in-scope transactions in them were missed. `observe` returns
 * the skipped range so the caller can re-fetch it; missing that is how the
 * archive silently drifts out of sync.
 */
export class GapTracker {
  #last: number | null;

  /** Anchor at a known-complete ledger (e.g. backfill's high-water mark) so a
   * jump between backfill end and tail start is itself detected as a gap. */
  constructor(startLedger?: number) {
    this.#last = startLedger ?? null;
  }

  /** Observe a validated ledger index; return the gap it revealed, or null. */
  observe(ledgerIndex: number): LedgerRange | null {
    if (this.#last === null) {
      this.#last = ledgerIndex;
      return null;
    }
    if (ledgerIndex <= this.#last) return null; // duplicate or out-of-order/old
    if (ledgerIndex === this.#last + 1) {
      this.#last = ledgerIndex;
      return null;
    }
    const gap: LedgerRange = { fromLedger: this.#last + 1, toLedger: ledgerIndex - 1 };
    this.#last = ledgerIndex;
    return gap;
  }

  /** Highest ledger index observed so far, or null before the first. */
  get lastContiguous(): number | null {
    return this.#last;
  }
}
