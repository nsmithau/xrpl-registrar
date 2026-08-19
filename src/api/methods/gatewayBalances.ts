import Big from "big.js";

import type { Database } from "../../db/database.js";
import { errorResult, invalidParams, notInArchive } from "../errors.js";
import type { ScopeRepository } from "../scope.js";
import type { ApiRequest, MethodResult } from "../types.js";
import { gatewayAssetsNotTrackedWarning } from "../warnings.js";
import { currencyToWire } from "../../xrpl/currency.js";

// Never emit exponential notation, so decimal strings stay numeric-safe.
Big.NE = -1_000_000;
Big.PE = 1_000_000;

interface IouIssuance {
  readonly id: number;
  readonly currency: string;
}

/**
 * Archive-scoped `gateway_balances` for an IOU issuer (ADR-017). The IOU
 * analogue of `mpt_holders`: given an issuer `account`, report `obligations` —
 * the total of each registered IOU currency in circulation, i.e. the sum of
 * every in-scope holder's balance as of the requested ledger (default: the
 * archive's latest). Holders named in `hotwallet` are broken out into
 * `balances` instead of counted in obligations, matching Clio.
 *
 * Fail-closed (the point of the method, not the arithmetic):
 * - not the issuer of any registered, enabled IOU issuance → `notInArchive`
 *   (never `actNotFound`, never an empty obligations map presented as fact);
 * - a requested ledger outside an issuance's guaranteed coverage → an explicit
 *   `outOfCoverage` error, never a silently under-counted total.
 *
 * `assets` (the issuer's own holdings of tokens issued by others) is out of
 * scope: the field is omitted and a warning says so, rather than returning `{}`.
 */
export async function handleGatewayBalances(
  db: Database,
  scope: ScopeRepository,
  req: ApiRequest,
): Promise<MethodResult> {
  const account = typeof req.account === "string" ? req.account : undefined;
  if (!account) return { result: invalidParams("'account' is required") };

  const hotwallets = parseHotwallets(req.hotwallet);
  if ("error" in hotwallets) return { result: invalidParams(hotwallets.error) };

  // Registered, enabled IOU issuances whose issuer is this account. MPT issuers
  // are served by mpt_holders; this method is IOU-only.
  const { rows: issRows } = await db.query<{ id: number | string; currency: string }>(
    "SELECT id, currency FROM issuances WHERE kind = 'iou' AND issuer_account = $1 AND enabled = true ORDER BY currency",
    [account],
  );
  if (issRows.length === 0) {
    return { result: notInArchive(`IOU issuer ${account}`, await scope.summarize()) };
  }
  const issuances: IouIssuance[] = issRows.map((r) => ({ id: Number(r.id), currency: r.currency }));

  // As of: an explicit ledger_index, or "validated"/"current"/"latest"/unset →
  // the archive's latest validated ledger. (Point-in-time by date is the job of
  // archive_balance_at; gateway_balances stays Clio-shaped.)
  const latest = await latestLedger(db);
  const resolved = resolveLedgerIndex(req.ledger_index, latest);
  if ("error" in resolved) return { result: invalidParams(resolved.error) };
  const ledger = resolved.ledger;

  // Fail closed on coverage: every currency must be guaranteed-complete at the
  // requested ledger, or the whole response is refused — a partial obligations
  // map must never look authoritative.
  for (const iss of issuances) {
    const cov = await conservativeCoverage(db, iss.id);
    if (!cov || ledger < cov.min || ledger > cov.max) {
      return {
        result: errorResult(
          "outOfCoverage",
          `The archive's guaranteed coverage for ${iss.currency}/${account} does not include ledger ${ledger}; refusing to report a possibly-incomplete total.`,
          {
            details: {
              currency: iss.currency,
              issuer: account,
              requestedLedger: ledger,
              coverage: cov,
            },
          },
        ),
      };
    }
  }

  const obligations: Record<string, string> = {};
  const balances: Record<string, { currency: string; value: string }[]> = {};

  for (const iss of issuances) {
    // Per-holder balance as of the ledger: the sum of its deltas up to and
    // including that ledger (exact; same primitive as archive_balance_at).
    const { rows } = await db.query<{ address: string; bal: string | null }>(
      `SELECT bd.address AS address, sum(bd.delta::numeric)::text AS bal
       FROM balance_deltas bd
       JOIN transactions t ON t.hash = bd.hash
       WHERE bd.issuance_id = $1 AND t.ledger_index <= $2
       GROUP BY bd.address`,
      [iss.id, ledger],
    );

    // Clio keys obligations/balances by the on-wire currency: a 3-char standard
    // code as-is, a non-standard code as its 40-hex form. Match it so a drop-in
    // client keys identically against us and a real Clio.
    const wireCurrency = currencyToWire(iss.currency);
    let obligation = new Big(0);
    for (const r of rows) {
      // The issuer never holds its own IOU via a trustline to itself; skip it
      // defensively so it can never leak into obligations/balances.
      if (r.address === account) continue;
      const bal = new Big(r.bal ?? "0");
      if (bal.eq(0)) continue;
      if (hotwallets.hotwallets.has(r.address)) {
        (balances[r.address] ??= []).push({ currency: wireCurrency, value: bal.toString() });
      } else {
        obligation = obligation.plus(bal);
      }
    }
    // Clio omits a currency with nothing outstanding; a zero here is a true
    // "nothing owed", not a scope miss (the issuer/coverage checks passed).
    if (!obligation.eq(0)) obligations[wireCurrency] = obligation.toString();
  }

  return {
    result: {
      status: "success",
      account,
      obligations,
      ...(Object.keys(balances).length > 0 ? { balances } : {}),
      ledger_index: ledger,
      validated: true,
    },
    // assets is out of scope for a filtered archive — omitted, not `{}`.
    extraWarnings: [gatewayAssetsNotTrackedWarning()],
  };
}

/** `hotwallet` may be a single address or an array of addresses (as in Clio). */
function parseHotwallets(raw: unknown): { hotwallets: Set<string> } | { error: string } {
  if (raw === undefined) return { hotwallets: new Set() };
  if (typeof raw === "string") return { hotwallets: new Set([raw]) };
  if (Array.isArray(raw) && raw.every((x) => typeof x === "string")) {
    return { hotwallets: new Set(raw as string[]) };
  }
  return { error: "'hotwallet' must be an account address or an array of addresses" };
}

/** Resolve `ledger_index` to a concrete ledger: a number as-is; the aliases
 * "validated"/"current"/"latest" or an unset value → the archive's latest. */
function resolveLedgerIndex(raw: unknown, latest: number): { ledger: number } | { error: string } {
  if (raw === undefined || raw === "validated" || raw === "current" || raw === "latest") {
    return { ledger: latest };
  }
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0) return { ledger: raw };
  return { error: "'ledger_index' must be a ledger number or \"validated\"" };
}

/** The archive's latest validated ledger: the tail's high-water if it has run,
 * else the newest ledger any archived transaction lands in. */
async function latestLedger(db: Database): Promise<number> {
  const { rows } = await db.query<{ hi: number | string | null }>(
    `SELECT max(hi) AS hi FROM (
       SELECT max(ledger_index) AS hi FROM ledgers
       UNION ALL SELECT max(ledger_index) FROM transactions
     ) x`,
  );
  return rows[0]?.hi != null ? Number(rows[0]!.hi) : 0;
}

/**
 * The conservative coverage window for an issuance: the ledger range over which
 * *every* in-scope account is guaranteed complete — `max(from_ledger)` (no
 * account starts later) to the tail's high-water once it has run, else the
 * backfill snapshot `min(to_ledger)`. Null when no coverage is recorded or the
 * ranges do not overlap. Mirrors the admin API's coverage semantics.
 */
async function conservativeCoverage(
  db: Database,
  issuanceId: number,
): Promise<{ min: number; max: number } | null> {
  const { rows } = await db.query<{
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
    [issuanceId],
  );
  const lo = rows[0]?.lo;
  const backfillHi = rows[0]?.backfill_hi;
  if (lo === null || lo === undefined || backfillHi === null || backfillHi === undefined)
    return null;
  const min = Number(lo);
  const tailHi = rows[0]?.tail_hi;
  const max =
    tailHi === null || tailHi === undefined
      ? Number(backfillHi)
      : Math.max(Number(tailHi), Number(backfillHi));
  return min > max ? null : { min, max };
}
