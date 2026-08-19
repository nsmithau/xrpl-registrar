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

/**
 * A keyset cursor `"<ledgerIndex>:<hash>"` naming the last row of the previous
 * page. Keyset paging (a `(ledger_index, hash)` comparison matching ORDER BY) is
 * stable under concurrent ingest, unlike a numeric OFFSET which shifts when the
 * live tail inserts newer rows between page fetches. Returns undefined for an
 * absent or unparseable marker (paging then starts from the beginning).
 */
function parseMarker(marker: unknown): { ledger: number; hash: string } | undefined {
  if (typeof marker !== "string") return undefined;
  const idx = marker.indexOf(":");
  if (idx < 0) return undefined;
  const ledger = Number(marker.slice(0, idx));
  const hash = marker.slice(idx + 1);
  if (!Number.isInteger(ledger) || ledger < 0 || hash === "") return undefined;
  return { ledger, hash };
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
  const cursor = parseMarker(req.marker);

  const reqMin = asNumber(req.ledger_index_min);
  const reqMax = asNumber(req.ledger_index_max);
  const covLo = coverage ? coverage.fromLedger : 0;
  const covHi = coverage ? coverage.toLedger : Number.MAX_SAFE_INTEGER;
  const qMin = reqMin !== undefined && reqMin >= 0 ? Math.max(reqMin, covLo) : covLo;
  const qMax = reqMax !== undefined && reqMax >= 0 ? Math.min(reqMax, covHi) : covHi;

  const order = ascending ? "ASC" : "DESC";
  // Keyset cursor: rows strictly past the previous page's last row, in the same
  // order as ORDER BY (a row-value comparison, so ties on ledger_index break on
  // hash consistently). Stable when the tail ingests concurrently.
  const params: unknown[] = [account, qMin, qMax];
  let keyset = "";
  if (cursor) {
    keyset = `AND (t.ledger_index, t.hash) ${ascending ? ">" : "<"} ($4, $5)`;
    params.push(cursor.ledger, cursor.hash);
  }
  params.push(limit + 1);
  const { rows } = await db.query<TxRow>(
    `SELECT t.tx_blob, t.meta_blob, t.ledger_index, t.hash, t.close_time_iso
     FROM account_transactions at
     JOIN transactions t ON t.hash = at.hash
     WHERE at.address = $1 AND t.ledger_index BETWEEN $2 AND $3 ${keyset}
     ORDER BY t.ledger_index ${order}, t.hash ${order}
     LIMIT $${params.length}`,
    params,
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const transactions = page.map((r) => (binary ? binaryEntry(r) : jsonEntry(r)));
  const last = page[page.length - 1];
  const nextMarker = hasMore && last ? `${Number(last.ledger_index)}:${last.hash}` : undefined;

  // Report a real ledger range, never a -1 echo (see design principles). With
  // coverage, the guaranteed-complete window; without a coverage row yet, the
  // actual span of data held for the account (with the below warning), falling
  // back to the archive's latest ledger when the account has no transactions.
  let idxMin: number;
  let idxMax: number;
  if (coverage) {
    idxMin = coverage.fromLedger;
    idxMax = coverage.toLedger;
  } else {
    const range = await scope.accountDataRange(account);
    idxMin = range ? range.lo : await scope.latestLedger();
    idxMax = range ? range.hi : idxMin;
  }

  const result: Record<string, unknown> = {
    status: "success",
    account,
    ledger_index_min: idxMin,
    ledger_index_max: idxMax,
    limit,
    transactions,
    validated: true,
    ...(nextMarker !== undefined ? { marker: nextMarker } : {}),
  };

  const extraWarnings = [];
  const belowCoverage =
    reqMin !== undefined && reqMin >= 0 && coverage && reqMin < coverage.fromLedger;
  const aboveCoverage =
    reqMax !== undefined && reqMax >= 0 && coverage && reqMax > coverage.toLedger;
  if (belowCoverage || aboveCoverage || !coverage) {
    extraWarnings.push(
      rangeBeyondCoverageWarning(
        {
          ...(reqMin !== undefined ? { min: reqMin } : {}),
          ...(reqMax !== undefined ? { max: reqMax } : {}),
        },
        coverage,
      ),
    );
  }

  return { result, extraWarnings };
}
