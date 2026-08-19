import type { Database } from "../../db/database.js";
import { invalidParams, notInArchive } from "../errors.js";
import type { AccountCoverage, ScopeRepository } from "../scope.js";
import { decodeMetaEntries, type MetaRow } from "../state/decode.js";
import { toAccountData, toAccountLines } from "../state/reconstruct.js";
import type { MetaEntry } from "../state/reconstruct.js";
import type { ApiRequest, MethodResult } from "../types.js";
import { rangeBeyondCoverageWarning } from "../warnings.js";
import type { ClioWarning } from "../../clio/types.js";

/**
 * The ledger to report a reconstruction is "as of", and any coverage warning.
 * With coverage, that is the guaranteed-complete ceiling. Without a coverage row
 * yet (in scope but not backfilled), report a *real* ledger — the newest one we
 * reconstructed through, else the archive's latest — never a `-1` echo, and warn
 * that the result is outside guaranteed coverage.
 */
async function asOfLedger(
  scope: ScopeRepository,
  coverage: AccountCoverage | null,
  entries: readonly MetaEntry[],
): Promise<{ ledgerIndex: number; warnings: ClioWarning[] }> {
  if (coverage) return { ledgerIndex: coverage.toLedger, warnings: [] };
  const fromData = entries.length
    ? Math.max(...entries.map((e) => e.ledgerIndex))
    : await scope.latestLedger();
  return { ledgerIndex: fromData, warnings: [rangeBeyondCoverageWarning({ max: fromData }, null)] };
}

function ledgerLimit(req: ApiRequest): number {
  return typeof req.ledger_index === "number" ? req.ledger_index : Number.MAX_SAFE_INTEGER;
}

/** Fetch an in-scope account's transaction metadata up to a ledger. */
async function accountMeta(db: Database, address: string, upTo: number): Promise<MetaRow[]> {
  const { rows } = await db.query<MetaRow>(
    `SELECT t.meta_blob, t.ledger_index
     FROM account_transactions at
     JOIN transactions t ON t.hash = at.hash
     WHERE at.address = $1 AND t.ledger_index <= $2`,
    [address, upTo],
  );
  return rows;
}

/**
 * Archive-scoped `account_info`. Returns the account's AccountRoot as of its
 * latest archived transaction (≤ the requested ledger), reconstructed from
 * metadata. `notInArchive` if the account is out of scope.
 */
export async function handleAccountInfo(
  db: Database,
  scope: ScopeRepository,
  req: ApiRequest,
): Promise<MethodResult> {
  const account = typeof req.account === "string" ? req.account : undefined;
  if (!account) return { result: invalidParams("'account' is required") };
  if (!(await scope.inScope(account))) {
    return { result: notInArchive(`Account ${account}`, await scope.summarize()) };
  }

  const entries = decodeMetaEntries(await accountMeta(db, account, ledgerLimit(req)));
  const accountData = toAccountData(entries, account);
  if (!accountData) {
    return {
      result: notInArchive(`AccountRoot for ${account}`, await scope.summarize()),
    };
  }

  const coverage = await scope.accountCoverage(account);
  const asOf = await asOfLedger(scope, coverage, entries);
  return {
    result: {
      status: "success",
      account_data: accountData,
      ledger_index: asOf.ledgerIndex,
      validated: true,
    },
    extraWarnings: asOf.warnings,
  };
}

/**
 * Archive-scoped `account_lines`. Reconstructs the account's trustlines from
 * the RippleState objects in its archived transaction metadata.
 */
export async function handleAccountLines(
  db: Database,
  scope: ScopeRepository,
  req: ApiRequest,
): Promise<MethodResult> {
  const account = typeof req.account === "string" ? req.account : undefined;
  if (!account) return { result: invalidParams("'account' is required") };
  if (!(await scope.inScope(account))) {
    return { result: notInArchive(`Account ${account}`, await scope.summarize()) };
  }

  const entries = decodeMetaEntries(await accountMeta(db, account, ledgerLimit(req)));
  const lines = toAccountLines(entries, account);
  const coverage = await scope.accountCoverage(account);
  const asOf = await asOfLedger(scope, coverage, entries);
  return {
    result: {
      status: "success",
      account,
      lines,
      ledger_index: asOf.ledgerIndex,
      validated: true,
    },
    extraWarnings: asOf.warnings,
  };
}
