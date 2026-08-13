import type { Provenance } from "../clio/types.js";
import type { Database } from "../db/database.js";
import {
  BackfillJobRepository,
  checkpointJob,
  completeJob,
  type BackfillJob,
} from "../db/repositories/backfillJobs.js";
import { insertTransactionRows, type IngestTransaction } from "../db/repositories/transactions.js";
import type { ClioReader } from "../discovery/types.js";
import { nullLogger, type Logger } from "../logging/logger.js";

import { mapBinaryEntry } from "./mapEntry.js";
import { accountTxPages, type BinaryTxEntry } from "./pages.js";

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
  readonly jobs: BackfillJobRepository;

  constructor(options: BackfillWorkerOptions) {
    this.#client = options.client;
    this.#db = options.db;
    this.#logger = options.logger ?? nullLogger;
    this.#pageLimit = options.pageLimit;
    this.#concurrency = Math.max(1, options.concurrency ?? 4);
    this.#mapEntry = options.mapEntry ?? mapBinaryEntry;
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
        await this.#db.transaction(async (t) => {
          for (const entry of page.entries) {
            const mapped = this.#mapEntry(entry, job.address, page.provenance);
            await insertTransactionRows(t, mapped);
            if (mapped.ledgerIndex > maxLedger) maxLedger = mapped.ledgerIndex;
          }
          await checkpointJob(t, job.id, page.marker, page.entries.length);
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
        this.#logger.info("backfill page", {
          account: job.address,
          ingested: page.entries.length,
          done: isFinal,
        });
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
   * at once. First reclaims jobs left `running` by a prior crash, then runs
   * concurrent claim→run loops that each atomically claim the next pending job.
   * All loops share the one governed client, so total upstream load stays under
   * the global concurrency cap regardless of `concurrency`.
   */
  async runIssuance(issuanceId: number): Promise<{ processed: number }> {
    await this.jobs.reclaimStale(issuanceId);
    let processed = 0;
    const loop = async (): Promise<void> => {
      for (;;) {
        const job = await this.jobs.claim(issuanceId);
        if (!job) break;
        await this.runJob(job);
        processed += 1;
      }
    };
    await Promise.all(Array.from({ length: this.#concurrency }, () => loop()));
    return { processed };
  }
}
