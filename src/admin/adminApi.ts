import type { Database } from "../db/database.js";
import { AccountRepository } from "../db/repositories/accounts.js";
import { IssuanceRepository, type IssuanceRecord } from "../db/repositories/issuances.js";
import { decodeMeta } from "../reconcile/incremental.js";
import { normalizeCurrency } from "../xrpl/currency.js";

import type { ActivityReport, ActivitySource } from "./activity.js";
import type { CloseTimeFiller } from "../api/ledgerTime.js";

export interface RegisterMptIssuance {
  readonly kind: "mpt";
  readonly mptIssuanceId: string;
  readonly backfillFromLedger?: number;
}

export interface RegisterIouIssuance {
  readonly kind: "iou";
  readonly currency: string;
  readonly issuer: string;
  readonly backfillFromLedger?: number;
}

export type RegisterIssuance = RegisterMptIssuance | RegisterIouIssuance;

export interface RecentTransaction {
  readonly hash: string;
  readonly ledgerIndex: number;
  readonly txType: string;
  /** Ledger close time as `YYYY-MM-DD HH:MM:SS` (UTC), or null if not yet
   * recorded (the tail records close times as ledgers close). */
  readonly closeTimeUtc: string | null;
  /** `TransactionResult` from the metadata (e.g. `tesSUCCESS`), or null. */
  readonly result: string | null;
  /** Which tracked issuance(s) this transaction relates to — a display label
   * (MPT ticker or short id; IOU currency) plus the full id/issuer for a
   * tooltip. Usually one; a holder-to-holder or shared-issuer tx can touch
   * several. Empty when no in-scope issuance is associated. */
  readonly identifiers: readonly { readonly label: string; readonly title: string }[];
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
  /** Lowest ledger a transaction affecting this issuance landed in, or null. */
  readonly earliestLedger: number | null;
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

/** Ellipsise a long identifier for display (12 head + 4 tail), matching the
 * dashboard's own `short()`. Used to label an MPT issuance that has no ticker. */
function shortId(s: string): string {
  return s.length > 18 ? `${s.slice(0, 12)}…${s.slice(-4)}` : s;
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
  readonly #fillCloseTimes: CloseTimeFiller | undefined;

  constructor(db: Database, activity?: ActivitySource, fillCloseTimes?: CloseTimeFiller) {
    this.#db = db;
    this.#issuances = new IssuanceRepository(db);
    this.#accounts = new AccountRepository(db);
    this.#activity = activity;
    this.#fillCloseTimes = fillCloseTimes;
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
   * dashboard's live activity feed (refreshed on its poll). The close time comes
   * from the tail-recorded `ledgers` table; the result is decoded from metadata. */
  async recentTransactions(limit = 5): Promise<RecentTransaction[]> {
    const { rows } = await this.#db.query<{
      hash: string;
      ledger_index: number | string;
      tx_type: string;
      meta_blob: Uint8Array;
      mpt_issuance_id: string | null;
    }>(
      "SELECT hash, ledger_index, tx_type, meta_blob, mpt_issuance_id FROM transactions ORDER BY ledger_index DESC, hash LIMIT $1",
      [limit],
    );

    // Associate each transaction with the tracked issuance(s) it relates to.
    // balance_deltas is the kind-agnostic link (a row per affected holder per
    // issuance, derived for MPT and IOU alike); union it with the transaction's
    // own mpt_issuance_id so an MPT tx still resolves before its deltas land.
    const hashes = rows.map((r) => r.hash);
    const idsByHash = new Map<string, Set<number>>();
    if (hashes.length > 0) {
      const placeholders = hashes.map((_, i) => `$${i + 1}`).join(",");
      const { rows: dr } = await this.#db.query<{ hash: string; issuance_id: number | string }>(
        `SELECT DISTINCT hash, issuance_id FROM balance_deltas WHERE hash IN (${placeholders})`,
        hashes,
      );
      for (const d of dr) {
        const set = idsByHash.get(d.hash) ?? new Set<number>();
        set.add(Number(d.issuance_id));
        idsByHash.set(d.hash, set);
      }
    }
    // Label map for every issuance (a small set): MPT -> ticker or short id;
    // IOU -> currency. Also index by mpt_issuance_id for the column fallback.
    const labelById = new Map<number, { label: string; title: string }>();
    const idByMpt = new Map<string, number>();
    for (const iss of await new IssuanceRepository(this.#db).list()) {
      const id = iss.id;
      if (iss.kind === "mpt" && iss.mptIssuanceId) {
        labelById.set(id, {
          label: iss.ticker ?? shortId(iss.mptIssuanceId),
          title: iss.mptIssuanceId,
        });
        idByMpt.set(iss.mptIssuanceId, id);
      } else if (iss.kind === "iou" && iss.currency && iss.issuerAccount) {
        labelById.set(id, { label: iss.currency, title: iss.issuerAccount });
      }
    }

    // The tail records close times going forward; backfilled ledgers have none.
    // Fill this small set on demand (cached) so their dates aren't blank.
    const ledgers = [...new Set(rows.map((r) => Number(r.ledger_index)))];
    if (this.#fillCloseTimes && ledgers.length > 0) await this.#fillCloseTimes(ledgers);

    const closeTimes = new Map<number, string>();
    if (ledgers.length > 0) {
      const placeholders = ledgers.map((_, i) => `$${i + 1}`).join(",");
      const { rows: tr } = await this.#db.query<{
        ledger_index: number | string;
        utc: string | null;
      }>(
        `SELECT ledger_index, to_char(close_time_iso AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS utc
         FROM ledgers WHERE ledger_index IN (${placeholders})`,
        ledgers,
      );
      for (const r of tr) if (r.utc) closeTimes.set(Number(r.ledger_index), r.utc);
    }

    return rows.map((r) => {
      const meta = decodeMeta(r.meta_blob);
      const result =
        meta && typeof meta["TransactionResult"] === "string"
          ? (meta["TransactionResult"] as string)
          : null;
      const ledgerIndex = Number(r.ledger_index);
      const ids = new Set<number>(idsByHash.get(r.hash) ?? []);
      if (r.mpt_issuance_id) {
        const id = idByMpt.get(r.mpt_issuance_id);
        if (id !== undefined) ids.add(id);
      }
      const identifiers = [...ids]
        .map((id) => labelById.get(id))
        .filter((v): v is { label: string; title: string } => v !== undefined)
        .sort((a, b) => a.label.localeCompare(b.label));
      return {
        hash: r.hash,
        ledgerIndex,
        txType: r.tx_type,
        closeTimeUtc: closeTimes.get(ledgerIndex) ?? null,
        result,
        identifiers,
      };
    });
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
      earliestLedger: tx.earliestLedger,
      latestLedger: tx.latestLedger,
      backfill: await this.#backfillSummary(id),
      coverage: await this.#coverage(id),
      lastReconciliation: await this.#lastReconciliation(id),
    };
  }

  /**
   * Transactions that affected *this* issuance's balances, and the earliest and
   * latest ledger one landed in. Scoped via `balance_deltas` (keyed by
   * `issuance_id`), not via `account_transactions` — an account may hold several
   * issuances from the same issuer, so joining through it would attribute one
   * issuance's transactions to every issuance its accounts touch (making sibling
   * MPTs report the same counts and ledgers).
   */
  async #transactionStats(
    id: number,
  ): Promise<{ count: number; earliestLedger: number | null; latestLedger: number | null }> {
    const { rows } = await this.#db.query<{
      c: number | string;
      lo: number | string | null;
      hi: number | string | null;
    }>(
      `SELECT count(DISTINCT bd.hash) AS c, min(t.ledger_index) AS lo, max(t.ledger_index) AS hi
       FROM balance_deltas bd
       JOIN transactions t ON t.hash = bd.hash
       WHERE bd.issuance_id = $1`,
      [id],
    );
    const toNum = (v: number | string | null | undefined) =>
      v === null || v === undefined ? null : Number(v);
    return {
      count: Number(rows[0]?.c ?? 0),
      earliestLedger: toNum(rows[0]?.lo),
      latestLedger: toNum(rows[0]?.hi),
    };
  }

  async setEnabled(id: number, enabled: boolean): Promise<boolean> {
    if ((await this.#issuances.getById(id)) === null) return false;
    await this.#issuances.setEnabled(id, enabled);
    return true;
  }

  async #backfillSummary(id: number): Promise<BackfillSummary> {
    const { rows } = await this.#db.query<{
      status: string;
      n: number | string;
      tx: number | string;
    }>(
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
    if (lo === null || lo === undefined || backfillHi === null || backfillHi === undefined)
      return null;
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
