import { runIssuerBackfill } from "../backfill/issuerSweep.js";
import type { Database } from "../db/database.js";
import { AccountRepository } from "../db/repositories/accounts.js";
import { BackfillJobRepository } from "../db/repositories/backfillJobs.js";
import { IssuanceRepository, type IssuanceRecord } from "../db/repositories/issuances.js";
import { asString } from "../discovery/fields.js";
import type { ClioReader } from "../discovery/types.js";
import { nullLogger, type Logger } from "../logging/logger.js";
import { BalanceDeltaRepository, deltaDeriver, trackedIssuance } from "../reconcile/index.js";
import { hexToBytes } from "../util/hex.js";
import { decodeMptIssuer } from "../xrpl/mpt.js";

import { noopActivityTracker, type ActivityTracker } from "./activity.js";

/**
 * Best-effort MPT ticker from on-ledger metadata: fetch the MPTokenIssuance via
 * `ledger_entry` and read the `t` field of its (JSON) `MPTokenMetadata`. Returns
 * null on any failure — a missing/non-JSON/tickerless metadata is not an error,
 * just no ticker to display.
 */
async function fetchMptTicker(client: ClioReader, mptIssuanceId: string): Promise<string | null> {
  try {
    const res = await client.request<{ node?: { MPTokenMetadata?: unknown } }>({
      command: "ledger_entry",
      mpt_issuance: mptIssuanceId,
    });
    const metaHex = asString(res.result.node?.MPTokenMetadata);
    if (!metaHex) return null;
    const parsed = JSON.parse(new TextDecoder().decode(hexToBytes(metaHex))) as Record<string, unknown>;
    const ticker = parsed["t"];
    return typeof ticker === "string" && ticker.length > 0 && ticker.length <= 32 ? ticker : null;
  } catch {
    return null;
  }
}

export interface IngestSummary {
  readonly strategy: string;
  readonly discovered: number;
  readonly jobsProcessed: number;
  readonly deltaRows: number;
}

/** The transport the orchestrator needs: governed reads plus connect/disconnect
 * are managed by the caller. */
export type OrchestratorClient = ClioReader;

/** The issuer address whose `account_tx` sweep backfills the whole issuance. */
export function issuerOf(issuance: IssuanceRecord): string {
  return issuance.kind === "mpt"
    ? decodeMptIssuer(issuance.mptIssuanceId ?? "")
    : (issuance.issuerAccount ?? "");
}

/**
 * Run the ingestion pipeline for a registered issuance with a **single
 * `account_tx` sweep on its issuer**: because every in-scope transaction appears
 * in the issuer's `account_tx`, one bounded, resumable sweep both discovers
 * every holder and backfills their history — no separate discovery pass and no
 * per-holder fan-out. Deltas are derived per transaction as each is ingested.
 */
export async function ingestIssuance(
  client: OrchestratorClient,
  db: Database,
  issuance: IssuanceRecord,
  logger: Logger = nullLogger,
  activity: ActivityTracker = noopActivityTracker,
): Promise<IngestSummary> {
  const label = issuance.kind === "mpt" ? issuance.mptIssuanceId : `${issuance.currency}/${issuance.issuerAccount}`;
  const issuer = issuerOf(issuance);
  const fromLedger = issuance.backfillFromLedger > 0 ? issuance.backfillFromLedger : 0;

  // The issuer must exist as an account (FK for the backfill job + coverage) —
  // it is not a holder, so it is recorded in `accounts` only, not scope.
  await db.query(
    "INSERT INTO accounts (address, first_seen_ledger) VALUES ($1, NULL) ON CONFLICT (address) DO NOTHING",
    [issuer],
  );

  // Capture the MPT ticker from on-ledger metadata (best-effort, one cheap call)
  // so the dashboard can show it in place of the 48-hex id.
  if (issuance.kind === "mpt" && issuance.mptIssuanceId) {
    const ticker = await fetchMptTicker(client, issuance.mptIssuanceId);
    if (ticker) await new IssuanceRepository(db).setTicker(issuance.id, ticker);
  }

  const jobs = new BackfillJobRepository(db);
  await jobs.enqueue(issuance.id, issuer, fromLedger, null, "issuer");
  // Resume/retry a prior sweep left running (crash) or failed (transient drop).
  await jobs.reclaimStale(issuance.id);
  const job = (await jobs.getByAccount(issuance.id, issuer))!;

  let processed = 0;
  if (job.status !== "completed") {
    await activity.track("backfill", `backfilling ${label ?? issuance.id}`, () =>
      runIssuerBackfill(client, db, trackedIssuance(issuance), job, {
        logger,
        deriveDeltas: deltaDeriver([trackedIssuance(issuance)]),
      }),
    );
    processed = 1;
  }

  // Close times are no longer captured eagerly here (one upstream `ledger` call
  // per in-scope ledger, whether or not anyone queries by time). Time-based
  // reporting resolves them lazily on demand (see lazyLedgerTimeResolver), and
  // the live tail records them forward as it runs.

  const deltaRows = await new BalanceDeltaRepository(db).count(issuance.id);
  const discovered = await new AccountRepository(db).countForIssuance(issuance.id);

  logger.info("issuance ingested", {
    issuanceId: issuance.id,
    strategy: "issuer_sweep",
    discovered,
    jobsProcessed: processed,
    deltaRows,
  });

  return { strategy: "issuer_sweep", discovered, jobsProcessed: processed, deltaRows };
}
