import type { Database } from "../db/database.js";
import { AccountRepository } from "../db/repositories/accounts.js";
import {
  IssuanceRepository,
  type DiscoveryStrategy,
  type IssuanceRecord,
} from "../db/repositories/issuances.js";

export interface RegisterMptIssuance {
  readonly kind: "mpt";
  readonly mptIssuanceId: string;
  readonly discoveryStrategy?: DiscoveryStrategy;
  readonly backfillFromLedger?: number;
}

export interface RegisterIouIssuance {
  readonly kind: "iou";
  readonly currency: string;
  readonly issuer: string;
  readonly discoveryStrategy?: DiscoveryStrategy;
  readonly backfillFromLedger?: number;
}

export type RegisterIssuance = RegisterMptIssuance | RegisterIouIssuance;

export interface BackfillSummary {
  readonly pending: number;
  readonly running: number;
  readonly completed: number;
  readonly failed: number;
  readonly totalTx: number;
}

export interface IssuanceStatus {
  readonly issuance: IssuanceRecord;
  readonly accounts: number;
  readonly backfill: BackfillSummary;
  readonly coverage: { readonly min: number; readonly max: number } | null;
  readonly lastReconciliation: {
    readonly runId: number;
    readonly passed: boolean;
    readonly discrepancies: number;
    readonly ranAt: string;
  } | null;
}

/**
 * The operator's control surface: register issuances (the unit of
 * configuration) and inspect their progress. Transport-decoupled and does no
 * long-running work itself — ingestion is triggered separately so a
 * registration call returns immediately.
 */
export class AdminApi {
  readonly #db: Database;
  readonly #issuances: IssuanceRepository;
  readonly #accounts: AccountRepository;

  constructor(db: Database) {
    this.#db = db;
    this.#issuances = new IssuanceRepository(db);
    this.#accounts = new AccountRepository(db);
  }

  async registerIssuance(input: RegisterIssuance): Promise<IssuanceRecord> {
    if (input.kind === "mpt") {
      return this.#issuances.create({
        kind: "mpt",
        mptIssuanceId: input.mptIssuanceId,
        ...(input.discoveryStrategy ? { discoveryStrategy: input.discoveryStrategy } : {}),
        ...(input.backfillFromLedger !== undefined
          ? { backfillFromLedger: input.backfillFromLedger }
          : {}),
      });
    }
    return this.#issuances.create({
      kind: "iou",
      currency: input.currency,
      issuerAccount: input.issuer,
      ...(input.discoveryStrategy ? { discoveryStrategy: input.discoveryStrategy } : {}),
      ...(input.backfillFromLedger !== undefined
        ? { backfillFromLedger: input.backfillFromLedger }
        : {}),
    });
  }

  listIssuances(): Promise<IssuanceRecord[]> {
    return this.#issuances.list();
  }

  async getIssuance(id: number): Promise<IssuanceStatus | null> {
    const issuance = await this.#issuances.getById(id);
    if (!issuance) return null;
    return {
      issuance,
      accounts: await this.#accounts.countForIssuance(id),
      backfill: await this.#backfillSummary(id),
      coverage: await this.#coverage(id),
      lastReconciliation: await this.#lastReconciliation(id),
    };
  }

  async setEnabled(id: number, enabled: boolean): Promise<boolean> {
    if ((await this.#issuances.getById(id)) === null) return false;
    await this.#issuances.setEnabled(id, enabled);
    return true;
  }

  async #backfillSummary(id: number): Promise<BackfillSummary> {
    const { rows } = await this.#db.query<{ status: string; n: number | string; tx: number | string }>(
      `SELECT status, count(*) AS n, sum(tx_count) AS tx
       FROM backfill_job WHERE issuance_id = $1 GROUP BY status`,
      [id],
    );
    const summary = { pending: 0, running: 0, completed: 0, failed: 0, totalTx: 0 };
    for (const r of rows) {
      const n = Number(r.n);
      summary.totalTx += Number(r.tx ?? 0);
      if (r.status === "pending") summary.pending = n;
      else if (r.status === "running") summary.running = n;
      else if (r.status === "completed") summary.completed = n;
      else if (r.status === "failed") summary.failed = n;
    }
    return summary;
  }

  async #coverage(id: number): Promise<{ min: number; max: number } | null> {
    const { rows } = await this.#db.query<{ lo: number | string | null; hi: number | string | null }>(
      `SELECT min(c.from_ledger) AS lo, max(c.to_ledger) AS hi
       FROM coverage c
       JOIN account_issuance ai ON ai.address = c.address
       WHERE ai.issuance_id = $1`,
      [id],
    );
    const lo = rows[0]?.lo;
    const hi = rows[0]?.hi;
    if (lo === null || lo === undefined || hi === null || hi === undefined) return null;
    return { min: Number(lo), max: Number(hi) };
  }

  async #lastReconciliation(id: number): Promise<IssuanceStatus["lastReconciliation"]> {
    const { rows } = await this.#db.query<{
      id: number | string;
      passed: boolean;
      discrepancies: number | string;
      ran_at: unknown;
    }>(
      `SELECT id, passed, discrepancies, ran_at FROM reconciliation_run
       WHERE issuance_id = $1 ORDER BY ran_at DESC, id DESC LIMIT 1`,
      [id],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      runId: Number(r.id),
      passed: r.passed,
      discrepancies: Number(r.discrepancies),
      ranAt: r.ran_at instanceof Date ? r.ran_at.toISOString() : String(r.ran_at),
    };
  }
}
