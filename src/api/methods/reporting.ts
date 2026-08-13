import type { Database } from "../../db/database.js";
import { LedgerTimeRepository } from "../../db/repositories/ledgers.js";
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
}

function asNum(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

async function resolveIssuance(db: Database, req: ApiRequest): Promise<ResolvedIssuance | null> {
  const mpt = typeof req.mpt_issuance_id === "string" ? req.mpt_issuance_id : undefined;
  if (mpt) {
    const { rows } = await db.query<{ id: number | string }>(
      "SELECT id FROM issuances WHERE mpt_issuance_id = $1",
      [mpt],
    );
    return rows.length ? { id: Number(rows[0]!.id), kind: "mpt" } : null;
  }
  const currency = typeof req.currency === "string" ? req.currency : undefined;
  const issuer = typeof req.issuer === "string" ? req.issuer : undefined;
  if (currency && issuer) {
    const { rows } = await db.query<{ id: number | string }>(
      "SELECT id FROM issuances WHERE kind = 'iou' AND currency = $1 AND issuer_account = $2",
      [currency, issuer],
    );
    return rows.length ? { id: Number(rows[0]!.id), kind: "iou" } : null;
  }
  return null;
}

/** Resolve a point in time to a ledger index: an explicit `ledgerKey` wins,
 * otherwise a `timeKey` ISO timestamp is mapped to the ledger in effect then. */
async function resolveLedger(
  db: Database,
  req: ApiRequest,
  ledgerKey: string,
  timeKey: string,
): Promise<{ ledger: number } | { error: string }> {
  const explicit = asNum(req[ledgerKey]);
  if (explicit !== undefined) return { ledger: explicit };
  const time = typeof req[timeKey] === "string" ? req[timeKey] : undefined;
  if (time) {
    const ledger = await new LedgerTimeRepository(db).resolveAtOrBefore(time);
    if (ledger === null) return { error: `no ledger recorded at or before ${time}` };
    return { ledger };
  }
  return { error: `'${ledgerKey}' (number) or '${timeKey}' (ISO timestamp) is required` };
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
    result: { status: "success", account, ledger_index: ledger, balance, validated: true },
    extraWarnings,
  };
}

/**
 * `archive_deltas` — net balance change per account over a ledger range
 * `[from_ledger, to_ledger]` for an issuance. Optionally scoped to one account.
 */
export async function handleDeltas(
  db: Database,
  scope: ScopeRepository,
  req: ApiRequest,
): Promise<MethodResult> {
  const issuance = await resolveIssuance(db, req);
  if (!issuance) return { result: notInArchive("Issuance", await scope.summarize()) };

  const fromResolved = await resolveLedger(db, req, "from_ledger", "from_time");
  if ("error" in fromResolved) return { result: invalidParams(fromResolved.error) };
  const toResolved = await resolveLedger(db, req, "to_ledger", "to_time");
  if ("error" in toResolved) return { result: invalidParams(toResolved.error) };
  const from = fromResolved.ledger;
  const to = toResolved.ledger;
  const account = typeof req.account === "string" ? req.account : undefined;

  const params: unknown[] = [issuance.id, from, to];
  let accountFilter = "";
  if (account) {
    params.push(account);
    accountFilter = "AND bd.address = $4";
  }

  const { rows } = await db.query<{ address: string; net: string }>(
    `SELECT bd.address AS address, sum(bd.delta::numeric)::text AS net
     FROM balance_deltas bd
     JOIN transactions t ON t.hash = bd.hash
     WHERE bd.issuance_id = $1 AND t.ledger_index BETWEEN $2 AND $3 ${accountFilter}
     GROUP BY bd.address ORDER BY bd.address`,
    params,
  );

  return {
    result: {
      status: "success",
      from_ledger: from,
      to_ledger: to,
      deltas: rows.map((r) => ({ account: r.address, delta: r.net })),
      validated: true,
    },
  };
}
