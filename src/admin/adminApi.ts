import type { Database } from "../db/database.js";
import { AccountRepository } from "../db/repositories/accounts.js";
import {
  IssuanceRepository,
  type DiscoveryStrategy,
  type IssuanceRecord,
} from "../db/repositories/issuances.js";
import { normalizeCurrency } from "../xrpl/currency.js";

import type { ActivityReport, ActivitySource } from "./activity.js";

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

export interface RecentTransaction {
  readonly hash: string;
  readonly ledgerIndex: number;
  readonly txType: string;
}

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
  /** Distinct transactions that affected this issuance's balances. */
  readonly transactions: number;
  /** Highest ledger a transaction affecting this issuance landed in, or null. */
  readonly latestLedger: number | null;
  readonly backfill: BackfillSummary;
  /** Conservative coverage: the ledger range over which every in-scope account
   * is complete — max backfill start … the tail's high-water (falling back to
   * the backfill snapshot before the tail runs). Null if they do not overlap. */
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
  readonly #activity: ActivitySource | undefined;

  constructor(db: Database, activity?: ActivitySource) {
    this.#db = db;
    this.#issuances = new IssuanceRepository(db);
    this.#accounts = new AccountRepository(db);
    this.#activity = activity;
  }

  /** Snapshot of background activity (backfill/discovery) for the dashboard, or
   * null when no registry is wired in. Reflects this process only. */
  activitySnapshot(): ActivityReport | null {
    return this.#activity?.snapshot() ?? null;
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
      // Accept the readable code or the 40-hex on-wire form; store the readable
      // code the archive matches against, and reject a malformed one outright.
      currency: normalizeCurrency(input.currency),
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

  /** Job progress for whatever issuances are being backfilled right now
   * (completed+failed / total, across issuances with in-flight jobs), or null
   * when nothing is backfilling — for the dashboard's live progress counter. */
  async backfillProgress(): Promise<{ done: number; total: number } | null> {
    const { rows } = await this.#db.query<{ done: number | string; total: number | string }>(
      `SELECT count(*) FILTER (WHERE status IN ('completed','failed'))::int AS done,
              count(*)::int AS total
       FROM backfill_job
       WHERE issuance_id IN (SELECT issuance_id FROM backfill_job WHERE status IN ('pending','running'))`,
    );
    const total = Number(rows[0]?.total ?? 0);
    if (total === 0) return null;
    return { done: Number(rows[0]?.done ?? 0), total };
  }

  /** The most recent transactions across the whole archive, newest first — the
   * dashboard's live activity feed (refreshed on its poll). */
  async recentTransactions(limit = 5): Promise<RecentTransaction[]> {
    const { rows } = await this.#db.query<{ hash: string; ledger_index: number | string; tx_type: string }>(
      "SELECT hash, ledger_index, tx_type FROM transactions ORDER BY ledger_index DESC, hash LIMIT $1",
      [limit],
    );
    return rows.map((r) => ({ hash: r.hash, ledgerIndex: Number(r.ledger_index), txType: r.tx_type }));
  }

  /** The latest ledger the archive has observed (max recorded close time) —
   * i.e. where the live subscription currently is. Null before any is seen. */
  async latestLedgerSeen(): Promise<number | null> {
    const { rows } = await this.#db.query<{ m: number | string | null }>(
      "SELECT max(ledger_index) AS m FROM ledgers",
    );
    const m = rows[0]?.m;
    return m === null || m === undefined ? null : Number(m);
  }

  async getIssuance(id: number): Promise<IssuanceStatus | null> {
    const issuance = await this.#issuances.getById(id);
    if (!issuance) return null;
    const tx = await this.#transactionStats(id);
    return {
      issuance,
      accounts: await this.#accounts.countForIssuance(id),
      transactions: tx.count,
      latestLedger: tx.latestLedger,
      backfill: await this.#backfillSummary(id),
      coverage: await this.#coverage(id),
      lastReconciliation: await this.#lastReconciliation(id),
    };
  }

  /**
   * Transactions that affected *this* issuance's balances, and the latest ledger
   * one landed in. Scoped via `balance_deltas` (keyed by `issuance_id`), not via
   * `account_transactions` — an account may hold several issuances from the same
   * issuer, so joining through it would attribute one issuance's transactions to
   * every issuance its accounts touch (making sibling MPTs report the same
   * counts and latest ledger).
   */
  async #transactionStats(id: number): Promise<{ count: number; latestLedger: number | null }> {
    const { rows } = await this.#db.query<{ c: number | string; hi: number | string | null }>(
      `SELECT count(DISTINCT bd.hash) AS c, max(t.ledger_index) AS hi
       FROM balance_deltas bd
       JOIN transactions t ON t.hash = bd.hash
       WHERE bd.issuance_id = $1`,
      [id],
    );
    const hi = rows[0]?.hi;
    return { count: Number(rows[0]?.c ?? 0), latestLedger: hi === null || hi === undefined ? null : Number(hi) };
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

  /**
   * The **conservative** coverage window: the ledger range over which *every*
   * backfilled in-scope account is complete.
   *
   * The floor is `max(from_ledger)` — the latest backfill start, so no account
   * begins later. The ceiling advances with the archive: the live tail keeps
   * every in-scope account current, so once it has run, completeness extends to
   * the tail's high-water (`max(ledgers.ledger_index)` — the latest ledger it has
   * processed) rather than freezing at the backfill snapshot `min(to_ledger)`.
   * Before any tail run it falls back to that snapshot. Returns null when the
   * ranges do not overlap (no single ledger is covered by every account).
   */
  async #coverage(id: number): Promise<{ min: number; max: number } | null> {
    const { rows } = await this.#db.query<{
      lo: number | string | null;
      backfill_hi: number | string | null;
      tail_hi: number | string | null;
    }>(
      `SELECT max(c.from_ledger) AS lo,
              min(c.to_ledger) AS backfill_hi,
              (SELECT max(ledger_index) FROM ledgers) AS tail_hi
       FROM coverage c
       JOIN account_issuance ai ON ai.address = c.address
       WHERE ai.issuance_id = $1`,
      [id],
    );
    const lo = rows[0]?.lo;
    const backfillHi = rows[0]?.backfill_hi;
    if (lo === null || lo === undefined || backfillHi === null || backfillHi === undefined) return null;
    const min = Number(lo);
    // Advance the ceiling to the tail's high-water when the tail has run.
    const tailHi = rows[0]?.tail_hi;
    const max =
      tailHi === null || tailHi === undefined
        ? Number(backfillHi)
        : Math.max(Number(tailHi), Number(backfillHi));
    return min > max ? null : { min, max };
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
