import type { Database, Queryable, Row } from "../database.js";

export type BackfillStatus = "pending" | "running" | "completed" | "failed";

export interface BackfillJob {
  readonly id: number;
  readonly address: string;
  readonly issuanceId: number;
  readonly fromLedger: number | null;
  readonly toLedger: number | null;
  /** Resume cursor: the last marker checkpointed, or null (start / done). */
  readonly lastMarker: unknown;
  readonly status: BackfillStatus;
  readonly txCount: number;
}

interface JobRow extends Row {
  id: number | string;
  address: string;
  issuance_id: number | string;
  from_ledger: number | string | null;
  to_ledger: number | string | null;
  last_marker: unknown;
  status: BackfillStatus;
  tx_count: number | string;
}

const COLUMNS = `id, address, issuance_id, from_ledger, to_ledger, last_marker, status, tx_count`;

function mapRow(row: JobRow): BackfillJob {
  return {
    id: Number(row.id),
    address: row.address,
    issuanceId: Number(row.issuance_id),
    fromLedger: row.from_ledger === null ? null : Number(row.from_ledger),
    toLedger: row.to_ledger === null ? null : Number(row.to_ledger),
    lastMarker: row.last_marker ?? undefined,
    status: row.status,
    txCount: Number(row.tx_count),
  };
}

/**
 * Advance a job's cursor. Called inside the same transaction as the page's
 * inserts, so a page's rows and its resume marker commit atomically — a crash
 * leaves the job pointing at the last fully-persisted page, never between.
 */
export async function checkpointJob(
  q: Queryable,
  jobId: number,
  marker: unknown,
  addedTx: number,
): Promise<void> {
  await q.query(
    `UPDATE backfill_job
       SET last_marker = $2::jsonb, tx_count = tx_count + $3, status = 'running', updated_at = now()
     WHERE id = $1`,
    [jobId, marker === undefined || marker === null ? null : JSON.stringify(marker), addedTx],
  );
}

/** Mark a job complete and clear its cursor (also inside the page transaction). */
export async function completeJob(q: Queryable, jobId: number): Promise<void> {
  await q.query(
    `UPDATE backfill_job
       SET status = 'completed', last_marker = NULL, updated_at = now()
     WHERE id = $1`,
    [jobId],
  );
}

/** One resumable backfill job per (account, issuance). */
export class BackfillJobRepository {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /** Create a job if one does not already exist; return the current job. */
  async enqueue(
    issuanceId: number,
    address: string,
    fromLedger: number | null = 0,
    toLedger: number | null = null,
  ): Promise<BackfillJob> {
    await this.#db.query(
      `INSERT INTO backfill_job (address, issuance_id, from_ledger, to_ledger, status)
       VALUES ($1, $2, $3, $4, 'pending')
       ON CONFLICT (address, issuance_id) DO NOTHING`,
      [address, issuanceId, fromLedger, toLedger],
    );
    const job = await this.getByAccount(issuanceId, address);
    if (!job) throw new Error(`Failed to enqueue backfill job for ${address}`);
    return job;
  }

  async enqueueMany(
    issuanceId: number,
    addresses: readonly string[],
    fromLedger: number | null = 0,
  ): Promise<void> {
    for (const address of addresses) await this.enqueue(issuanceId, address, fromLedger);
  }

  /**
   * Atomically claim the next pending job, transitioning it to `running` in a
   * single statement so two concurrent workers never grab the same job.
   * `FOR UPDATE SKIP LOCKED` keeps this correct across connections too.
   */
  async claim(issuanceId?: number): Promise<BackfillJob | null> {
    const where = issuanceId === undefined ? "" : "AND issuance_id = $1";
    const params = issuanceId === undefined ? [] : [issuanceId];
    const { rows } = await this.#db.query<JobRow>(
      `UPDATE backfill_job SET status = 'running', updated_at = now()
       WHERE id = (
         SELECT id FROM backfill_job
         WHERE status = 'pending' ${where}
         ORDER BY id LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING ${COLUMNS}`,
      params,
    );
    return rows.length ? mapRow(rows[0]!) : null;
  }

  /** Return interrupted (`running`) jobs to `pending` — call once at startup to
   * reclaim jobs orphaned by a previous crash before claiming concurrently. */
  async reclaimStale(issuanceId?: number): Promise<number> {
    const where = issuanceId === undefined ? "" : "AND issuance_id = $1";
    const params = issuanceId === undefined ? [] : [issuanceId];
    const { rows } = await this.#db.query<{ id: number | string }>(
      `UPDATE backfill_job SET status = 'pending', updated_at = now()
       WHERE status = 'running' ${where} RETURNING id`,
      params,
    );
    return rows.length;
  }

  async fail(jobId: number): Promise<void> {
    await this.#db.query(
      "UPDATE backfill_job SET status = 'failed', updated_at = now() WHERE id = $1",
      [jobId],
    );
  }

  async get(jobId: number): Promise<BackfillJob | null> {
    const { rows } = await this.#db.query<JobRow>(
      `SELECT ${COLUMNS} FROM backfill_job WHERE id = $1`,
      [jobId],
    );
    return rows.length ? mapRow(rows[0]!) : null;
  }

  async getByAccount(issuanceId: number, address: string): Promise<BackfillJob | null> {
    const { rows } = await this.#db.query<JobRow>(
      `SELECT ${COLUMNS} FROM backfill_job WHERE issuance_id = $1 AND address = $2`,
      [issuanceId, address],
    );
    return rows.length ? mapRow(rows[0]!) : null;
  }

  async listForIssuance(issuanceId: number): Promise<BackfillJob[]> {
    const { rows } = await this.#db.query<JobRow>(
      `SELECT ${COLUMNS} FROM backfill_job WHERE issuance_id = $1 ORDER BY id`,
      [issuanceId],
    );
    return rows.map(mapRow);
  }
}
