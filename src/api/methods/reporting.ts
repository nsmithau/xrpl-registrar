import type { Database } from "../../db/database.js";
import { LedgerTimeRepository } from "../../db/repositories/ledgers.js";
import { currencyToString } from "../../xrpl/currency.js";
import { invalidParams, notInArchive } from "../errors.js";
import type { ScopeRepository } from "../scope.js";
import type { ApiRequest, MethodResult } from "../types.js";
import { rangeBeyondCoverageWarning } from "../warnings.js";

/**
 * Reporting extensions, under a distinct `archive_*` namespace — not
 * Clio-shaped, because Clio has no equivalent and forcing reporting into
 * Clio methods would misrepresent them. Balances and period deltas are
 * computed exactly from the derived `balance_deltas`, joined to each
 * transaction's ledger so results can be evaluated as of any ledger.
 */

interface ResolvedIssuance {
  readonly id: number;
  readonly kind: "mpt" | "iou";
  readonly mptIssuanceId: string | null;
  readonly currency: string | null;
  readonly issuer: string | null;
}

type IssuanceRow = {
  id: number | string;
  kind: "mpt" | "iou";
  mpt_issuance_id: string | null;
  currency: string | null;
  issuer_account: string | null;
};

const ISSUANCE_COLS = "id, kind, mpt_issuance_id, currency, issuer_account";

function toIssuance(r: IssuanceRow): ResolvedIssuance {
  return {
    id: Number(r.id),
    kind: r.kind,
    mptIssuanceId: r.mpt_issuance_id,
    currency: r.currency,
    issuer: r.issuer_account,
  };
}

/** The issuance's native identifier, echoed in reporting responses. */
function issuanceIdentity(iss: ResolvedIssuance): Record<string, unknown> {
  return iss.kind === "mpt"
    ? { mpt_issuance_id: iss.mptIssuanceId }
    : { currency: iss.currency, issuer: iss.issuer };
}

function asNum(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Parse an `issuance_id` sent as a JSON number or a numeric string. */
function asIssuanceId(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

async function resolveIssuance(db: Database, req: ApiRequest): Promise<ResolvedIssuance | null> {
  // An explicit `issuance_id` (the archive's local numeric id, as shown by the
  // admin API/dashboard) names either kind uniformly. It is instance-local — not
  // portable across archive instances — so the ledger-native identifiers below
  // remain the canonical, reproducible way to name an issuance.
  const issuanceId = asIssuanceId(req.issuance_id);
  if (issuanceId !== undefined) {
    const { rows } = await db.query<IssuanceRow>(
      `SELECT ${ISSUANCE_COLS} FROM issuances WHERE id = $1`,
      [issuanceId],
    );
    return rows.length ? toIssuance(rows[0]!) : null;
  }

  const mpt = typeof req.mpt_issuance_id === "string" ? req.mpt_issuance_id : undefined;
  if (mpt) {
    const { rows } = await db.query<IssuanceRow>(
      `SELECT ${ISSUANCE_COLS} FROM issuances WHERE mpt_issuance_id = $1`,
      [mpt],
    );
    return rows.length ? toIssuance(rows[0]!) : null;
  }
  const currency = typeof req.currency === "string" ? req.currency : undefined;
  const issuer = typeof req.issuer === "string" ? req.issuer : undefined;
  if (currency && issuer) {
    // Match the normalisation applied at registration: accept the readable code
    // or the 40-hex form, comparing against the stored readable code.
    const { rows } = await db.query<IssuanceRow>(
      `SELECT ${ISSUANCE_COLS} FROM issuances WHERE kind = 'iou' AND currency = $1 AND issuer_account = $2`,
      [currencyToString(currency), issuer],
    );
    return rows.length ? toIssuance(rows[0]!) : null;
  }
  return null;
}

/** The latest ledger the archive holds a transaction in — what `"validated"`
 * resolves to. Null when the archive is empty. */
async function archiveLatestLedger(db: Database): Promise<number | null> {
  const { rows } = await db.query<{ hi: number | string | null }>(
    "SELECT max(ledger_index) AS hi FROM transactions",
  );
  const hi = rows[0]?.hi;
  return hi === null || hi === undefined ? null : Number(hi);
}

/**
 * Resolve a point in time to a ledger index: `"validated"`/`"current"`/`"latest"`
 * → the archive's latest ledger; an explicit numeric `ledgerKey`; or a `timeKey`
 * ISO timestamp mapped to the ledger in effect then.
 */
async function resolveLedger(
  db: Database,
  req: ApiRequest,
  ledgerKey: string,
  timeKey: string,
): Promise<{ ledger: number } | { error: string }> {
  const raw = req[ledgerKey];
  if (raw === "validated" || raw === "current" || raw === "latest") {
    const latest = await archiveLatestLedger(db);
    if (latest === null) return { error: "the archive holds no transactions yet" };
    return { ledger: latest };
  }
  const explicit = asNum(raw);
  if (explicit !== undefined) return { ledger: explicit };
  const time = typeof req[timeKey] === "string" ? req[timeKey] : undefined;
  if (time) {
    const ledger = await new LedgerTimeRepository(db).resolveAtOrBefore(time);
    if (ledger === null) return { error: `no ledger recorded at or before ${time}` };
    return { ledger };
  }
  return { error: `'${ledgerKey}' (a number or "validated") or '${timeKey}' (ISO timestamp) is required` };
}

async function inIssuanceScope(db: Database, issuanceId: number, address: string): Promise<boolean> {
  const { rows } = await db.query(
    "SELECT 1 FROM account_issuance WHERE issuance_id = $1 AND address = $2 LIMIT 1",
    [issuanceId, address],
  );
  return rows.length > 0;
}

/**
 * `archive_balance_at` — an account's balance in an issuance as of a ledger:
 * the sum of its deltas up to and including that ledger. Exact (integer for
 * MPT, decimal for IOU). Warns if the ledger exceeds the account's coverage.
 */
export async function handleBalanceAt(
  db: Database,
  scope: ScopeRepository,
  req: ApiRequest,
): Promise<MethodResult> {
  const issuance = await resolveIssuance(db, req);
  if (!issuance) return { result: notInArchive("Issuance", await scope.summarize()) };

  const account = typeof req.account === "string" ? req.account : undefined;
  if (!account) return { result: invalidParams("'account' is required") };

  const resolved = await resolveLedger(db, req, "ledger_index", "date");
  if ("error" in resolved) return { result: invalidParams(resolved.error) };
  const ledger = resolved.ledger;

  if (!(await inIssuanceScope(db, issuance.id, account))) {
    return { result: notInArchive(`Account ${account}`, await scope.summarize()) };
  }

  const { rows } = await db.query<{ bal: string | null }>(
    `SELECT sum(bd.delta::numeric)::text AS bal
     FROM balance_deltas bd
     JOIN transactions t ON t.hash = bd.hash
     WHERE bd.issuance_id = $1 AND bd.address = $2 AND t.ledger_index <= $3`,
    [issuance.id, account, ledger],
  );
  const balance = rows[0]?.bal ?? "0";

  const extraWarnings = [];
  const coverage = await scope.accountCoverage(account);
  if (coverage && ledger > coverage.toLedger) {
    extraWarnings.push(rangeBeyondCoverageWarning({ max: ledger }, coverage));
  }

  return {
    result: {
      status: "success",
      ...issuanceIdentity(issuance),
      account,
      ledger_index: ledger,
      balance,
      validated: true,
    },
    extraWarnings,
  };
}

/** Shared setup for the range-scoped reporting methods: resolve the issuance and
 * the `[from, to]` ledger range, and build the `balance_deltas` filter. Returns
 * `{ result }` on any failure (to surface directly), otherwise the query parts. */
async function resolveRange(
  db: Database,
  scope: ScopeRepository,
  req: ApiRequest,
): Promise<
  | { result: Record<string, unknown> }
  | { issuance: ResolvedIssuance; from: number; to: number; params: unknown[]; accountFilter: string }
> {
  const issuance = await resolveIssuance(db, req);
  if (!issuance) return { result: notInArchive("Issuance", await scope.summarize()) };

  const fromResolved = await resolveLedger(db, req, "from_ledger", "from_time");
  if ("error" in fromResolved) return { result: invalidParams(fromResolved.error) };
  const toResolved = await resolveLedger(db, req, "to_ledger", "to_time");
  if ("error" in toResolved) return { result: invalidParams(toResolved.error) };

  const account = typeof req.account === "string" ? req.account : undefined;
  const params: unknown[] = [issuance.id, fromResolved.ledger, toResolved.ledger];
  let accountFilter = "";
  if (account) {
    params.push(account);
    accountFilter = "AND bd.address = $4";
  }
  return { issuance, from: fromResolved.ledger, to: toResolved.ledger, params, accountFilter };
}

/**
 * `archive_deltas` — net balance change per account over a ledger range
 * `[from_ledger, to_ledger]` for an issuance. Optionally scoped to one account.
 * (For the itemised, per-transaction changes, use `archive_transactions`.)
 */
export async function handleDeltas(
  db: Database,
  scope: ScopeRepository,
  req: ApiRequest,
): Promise<MethodResult> {
  const r = await resolveRange(db, scope, req);
  if ("result" in r) return { result: r.result };

  const { rows } = await db.query<{ address: string; net: string }>(
    `SELECT bd.address AS address, sum(bd.delta::numeric)::text AS net
     FROM balance_deltas bd
     JOIN transactions t ON t.hash = bd.hash
     WHERE bd.issuance_id = $1 AND t.ledger_index BETWEEN $2 AND $3 ${r.accountFilter}
     GROUP BY bd.address ORDER BY bd.address`,
    r.params,
  );

  return {
    result: {
      status: "success",
      ...issuanceIdentity(r.issuance),
      from_ledger: r.from,
      to_ledger: r.to,
      deltas: rows.map((row) => ({ account: row.address, delta: row.net })),
      validated: true,
    },
  };
}

/**
 * `archive_transactions` — the itemised balance-changing transactions for an
 * issuance over a ledger range: one entry per (transaction, account) with the
 * account, signed delta, ledger, and transaction hash, oldest first. Optionally
 * scoped to one account. Where `archive_deltas` gives the net per account, this
 * traces each change to the transaction that caused it.
 */
export async function handleTransactions(
  db: Database,
  scope: ScopeRepository,
  req: ApiRequest,
): Promise<MethodResult> {
  const r = await resolveRange(db, scope, req);
  if ("result" in r) return { result: r.result };

  const { rows } = await db.query<{ address: string; delta: string; ledger: number | string; hash: string }>(
    `SELECT bd.address AS address, bd.delta AS delta, t.ledger_index AS ledger, bd.hash AS hash
     FROM balance_deltas bd
     JOIN transactions t ON t.hash = bd.hash
     WHERE bd.issuance_id = $1 AND t.ledger_index BETWEEN $2 AND $3 ${r.accountFilter}
     ORDER BY t.ledger_index, bd.address`,
    r.params,
  );

  return {
    result: {
      status: "success",
      ...issuanceIdentity(r.issuance),
      from_ledger: r.from,
      to_ledger: r.to,
      transactions: rows.map((row) => ({
        account: row.address,
        delta: row.delta,
        ledger: Number(row.ledger),
        hash: row.hash,
      })),
      validated: true,
    },
  };
}
