import { decode } from "xrpl";

import type { Database, Row } from "../../db/database.js";
import { bytesToHex } from "../../util/hex.js";
import { invalidParams, notInArchive } from "../errors.js";
import type { ScopeRepository } from "../scope.js";
import type { ApiRequest, MethodResult } from "../types.js";
import { rangeBeyondCoverageWarning } from "../warnings.js";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 400;

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clampLimit(value: unknown): number {
  const n = asNumber(value);
  if (n === undefined) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(n)));
}

function markerOffset(marker: unknown): number {
  if (typeof marker === "string") {
    const n = Number.parseInt(marker, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 0;
}

interface TxRow extends Row {
  tx_blob: Uint8Array;
  meta_blob: Uint8Array;
  ledger_index: number | string;
  hash: string;
  close_time_iso: unknown;
}

function binaryEntry(r: TxRow): Record<string, unknown> {
  return {
    tx_blob: bytesToHex(r.tx_blob),
    meta_blob: bytesToHex(r.meta_blob),
    ledger_index: Number(r.ledger_index),
    validated: true,
  };
}

function jsonEntry(r: TxRow): Record<string, unknown> {
  return {
    tx_json: decode(bytesToHex(r.tx_blob)) as Record<string, unknown>,
    meta: decode(bytesToHex(r.meta_blob)) as Record<string, unknown>,
    hash: r.hash,
    ledger_index: Number(r.ledger_index),
    validated: true,
  };
}

/**
 * Archive-scoped `account_tx`. Scope-checked (fail-closed `notInArchive` when
 * out of scope), served from stored blobs in JSON or binary, reporting honest
 * `ledger_index_min`/`ledger_index_max` from coverage (never `-1` echo) and
 * warning when the requested range exceeds guaranteed coverage.
 */
export async function handleAccountTx(
  db: Database,
  scope: ScopeRepository,
  req: ApiRequest,
): Promise<MethodResult> {
  const account = typeof req.account === "string" ? req.account : undefined;
  if (!account) return { result: invalidParams("'account' is required") };

  if (!(await scope.inScope(account))) {
    return { result: notInArchive(`Account ${account}`, await scope.summarize()) };
  }

  const coverage = await scope.accountCoverage(account);
  const binary = req.binary === true;
  const ascending = req.forward === true;
  const limit = clampLimit(req.limit);
  const offset = markerOffset(req.marker);

  const reqMin = asNumber(req.ledger_index_min);
  const reqMax = asNumber(req.ledger_index_max);
  const covLo = coverage ? coverage.fromLedger : 0;
  const covHi = coverage ? coverage.toLedger : Number.MAX_SAFE_INTEGER;
  const qMin = reqMin !== undefined && reqMin >= 0 ? Math.max(reqMin, covLo) : covLo;
  const qMax = reqMax !== undefined && reqMax >= 0 ? Math.min(reqMax, covHi) : covHi;

  const order = ascending ? "ASC" : "DESC";
  const { rows } = await db.query<TxRow>(
    `SELECT t.tx_blob, t.meta_blob, t.ledger_index, t.hash, t.close_time_iso
     FROM account_transactions at
     JOIN transactions t ON t.hash = at.hash
     WHERE at.address = $1 AND t.ledger_index BETWEEN $2 AND $3
     ORDER BY t.ledger_index ${order}, t.hash ${order}
     LIMIT $4 OFFSET $5`,
    [account, qMin, qMax, limit + 1, offset],
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const transactions = page.map((r) => (binary ? binaryEntry(r) : jsonEntry(r)));

  const result: Record<string, unknown> = {
    status: "success",
    account,
    ledger_index_min: coverage ? coverage.fromLedger : -1,
    ledger_index_max: coverage ? coverage.toLedger : -1,
    limit,
    transactions,
    validated: true,
    ...(hasMore ? { marker: String(offset + limit) } : {}),
  };

  const extraWarnings = [];
  const belowCoverage = reqMin !== undefined && reqMin >= 0 && coverage && reqMin < coverage.fromLedger;
  const aboveCoverage = reqMax !== undefined && reqMax >= 0 && coverage && reqMax > coverage.toLedger;
  if (belowCoverage || aboveCoverage || !coverage) {
    extraWarnings.push(
      rangeBeyondCoverageWarning(
        { ...(reqMin !== undefined ? { min: reqMin } : {}), ...(reqMax !== undefined ? { max: reqMax } : {}) },
        coverage,
      ),
    );
  }

  return { result, extraWarnings };
}
