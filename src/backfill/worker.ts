import type { Provenance } from "../clio/types.js";
import type { Database } from "../db/database.js";
import {
  BackfillJobRepository,
  checkpointJob,
  completeJob,
  type BackfillJob,
} from "../db/repositories/backfillJobs.js";
import {
  insertTransactionRowsMany,
  type IngestTransaction,
} from "../db/repositories/transactions.js";
import type { ClioReader } from "../discovery/types.js";
import { nullLogger, type Logger } from "../logging/logger.js";
import { decodeMeta, type DeriveDeltas } from "../reconcile/incremental.js";

import { mapBinaryEntry } from "./mapEntry.js";
import { accountTxPages, type BinaryTxEntry } from "./pages.js";

/** Emit a running progress counter at most every this many transactions. */
const BACKFILL_PROGRESS_EVERY = 1000;

export interface BackfillWorkerOptions {
  readonly client: ClioReader;
  readonly db: Database;
  readonly logger?: Logger;
  /** Page size requested from upstream. */
  readonly pageLimit?: number;
  /** How many accounts to backfill concurrently. All share the one governor,
   * so this never exceeds the global upstream concurrency cap. Default 4. */
  readonly concurrency?: number;
  /** Override the entry→row mapping (defaults to decoding raw binary blobs). */
  readonly mapEntry?: (
    entry: BinaryTxEntry,
    account: string,
    provenance: Provenance,
  ) => IngestTransaction;
  /** Which of an account's `account_tx` entries to ingest. A discovered holder's
   * `account_tx` also carries its unrelated activity (offers, XRP, other
   * tokens); the archive is issuance-scoped, so `serve` passes a predicate that
   * keeps only transactions touching a tracked issuance — the same filter the
   * issuer sweep, gap heal, and live tail apply. Default: keep all. */
  readonly keep?: (entry: BinaryTxEntry) => boolean;
  /** Derive each transaction's balance deltas as it is ingested, on the same DB
   * transaction as the insert (so backfilled history has deltas without a
   * separate full re-scan). Default: none. */
  readonly deriveDeltas?: DeriveDeltas;
}

/**
 * Backfills an issuance's accounts from Clio.
 *
 * Per account it pages `account_tx` forward from the job's `fromLedger`, and for
 * each page writes the transactions and advances the resume marker **in one DB
 * transaction**. That atomicity is the whole game: a crash leaves the job at the
 * last fully-persisted page, and because ingest is idempotent, resuming re-runs
 * at most the final in-flight page with no gaps and no duplicates.
 *
 * Jobs are processed sequentially here; the global governor already caps
 * upstream load. Parallel fan-out across worker threads is a later step.
 */
export class BackfillWorker {
  readonly #client: ClioReader;
  readonly #db: Database;
  readonly #logger: Logger;
  readonly #pageLimit: number | undefined;
  readonly #concurrency: number;
  readonly #mapEntry: NonNullable<BackfillWorkerOptions["mapEntry"]>;
  readonly #keep: (entry: BinaryTxEntry) => boolean;
  readonly #deriveDeltas: DeriveDeltas;
  readonly jobs: BackfillJobRepository;
  /** Session-wide running total of transactions ingested, for the throttled
   * progress counter (shared across concurrently-backfilled accounts). */
  #ingestedTotal = 0;
  #lastProgressAt = 0;

  constructor(options: BackfillWorkerOptions) {
    this.#client = options.client;
    this.#db = options.db;
    this.#logger = options.logger ?? nullLogger;
    this.#pageLimit = options.pageLimit;
    this.#concurrency = Math.max(1, options.concurrency ?? 4);
    this.#mapEntry = options.mapEntry ?? mapBinaryEntry;
    this.#keep = options.keep ?? (() => true);
    this.#deriveDeltas = options.deriveDeltas ?? (() => Promise.resolve());
    this.jobs = new BackfillJobRepository(options.db);
  }

  async enqueue(
    issuanceId: number,
    addresses: readonly string[],
    fromLedger: number | null = 0,
  ): Promise<void> {
    await this.jobs.enqueueMany(issuanceId, addresses, fromLedger);
  }

  /** Run a single job to completion (or resume it from its checkpoint). */
  async runJob(job: BackfillJob): Promise<BackfillJob> {
    let maxLedger = job.fromLedger ?? 0;
    try {
      for await (const page of accountTxPages(this.#client, {
        account: job.address,
        fromLedger: job.fromLedger ?? undefined,
        toLedger: job.toLedger ?? undefined,
        startMarker: job.lastMarker,
        limit: this.#pageLimit,
      })) {
        const isFinal = page.marker === undefined;
        // Coverage reflects the full scanned range (we saw every tx up to here),
        // even where none were in scope — so the ceiling is the last ledger seen.
        for (const entry of page.entries)
          if (entry.ledger_index > maxLedger) maxLedger = entry.ledger_index;
        // Ingest only in-scope entries: a discovered holder's account_tx also
        // carries its unrelated activity, which the archive does not track.
        const mapped = page.entries
          .filter((entry) => this.#keep(entry))
          .map((entry) => this.#mapEntry(entry, job.address, page.provenance));
        await this.#db.transaction(async (t) => {
          // Batch the page's rows (one multi-row statement per table), then derive
          // deltas per transaction (the rows exist, so the delta FK is satisfied).
          if (mapped.length > 0) {
            await insertTransactionRowsMany(t, mapped);
            for (const m of mapped) await this.#deriveDeltas(t, m.hash, decodeMeta(m.metaBlob));
          }
          await checkpointJob(t, job.id, page.marker, mapped.length);
          if (isFinal) {
            await completeJob(t, job.id);
            // Coverage is only claimed once the account is exhausted: complete
            // from the bounded start to the last ledger we actually reached.
            await t.query(
              `INSERT INTO coverage (address, from_ledger, to_ledger, reason)
               VALUES ($1, $2, $3, $4)`,
              [
                job.address,
                job.fromLedger ?? 0,
                maxLedger,
                `backfill account_tx exhausted from ledger ${job.fromLedger ?? 0}`,
              ],
            );
          }
        });
        // A single running counter across all accounts, throttled — not a line
        // per account or page.
        this.#ingestedTotal += mapped.length;
        if (this.#ingestedTotal - this.#lastProgressAt >= BACKFILL_PROGRESS_EVERY) {
          this.#lastProgressAt = this.#ingestedTotal;
          this.#logger.info("backfill progress", { tx: this.#ingestedTotal });
        }
      }
    } catch (err) {
      await this.jobs.fail(job.id);
      throw err;
    }
    const updated = await this.jobs.get(job.id);
    return updated ?? job;
  }

  /**
   * Process every job for an issuance, backfilling up to `concurrency` accounts
   * at once. First reclaims jobs left `running` (crash) or `failed` (a prior
   * run) so they are retried, then runs concurrent claim→run loops that each
   * atomically claim the next pending job. All loops share the one governed
   * client, so total upstream load stays under the global concurrency cap.
   *
   * A single account's failure is **isolated**: the job is marked `failed` and
   * the run continues with the others, so one transient upstream drop can't
   * abort a whole multi-thousand-account backfill. Failed jobs are retried on a
   * later run (they are reclaimed above). Returns how many jobs completed and
   * how many failed this run.
   */
  async runIssuance(issuanceId: number): Promise<{ processed: number; failed: number }> {
    await this.jobs.reclaimStale(issuanceId);
    let processed = 0;
    let failed = 0;
    const loop = async (): Promise<void> => {
      for (;;) {
        const job = await this.jobs.claim(issuanceId);
        if (!job) break;
        try {
          await this.runJob(job);
          processed += 1;
        } catch (err) {
          // runJob already marked the job failed; keep going with the others.
          failed += 1;
          this.#logger.warn("backfill job failed; continuing", {
            account: job.address,
            error: String(err),
          });
        }
      }
    };
    await Promise.all(Array.from({ length: this.#concurrency }, () => loop()));
    return { processed, failed };
  }
}
