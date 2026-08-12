import type { Database } from "../../db/database.js";
import { invalidParams, notInArchive } from "../errors.js";
import type { ScopeRepository } from "../scope.js";
import { decodeMetaEntries, type MetaRow } from "../state/decode.js";
import { toAccountData, toAccountLines } from "../state/reconstruct.js";
import type { ApiRequest, MethodResult } from "../types.js";

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
  return {
    result: {
      status: "success",
      account_data: accountData,
      ledger_index: coverage ? coverage.toLedger : -1,
      validated: true,
    },
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
  return {
    result: {
      status: "success",
      account,
      lines,
      ledger_index: coverage ? coverage.toLedger : -1,
      validated: true,
    },
  };
}
