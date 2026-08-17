import { runIssuerBackfill } from "../backfill/issuerSweep.js";
import type { Database } from "../db/database.js";
import { AccountRepository } from "../db/repositories/accounts.js";
import { BackfillJobRepository } from "../db/repositories/backfillJobs.js";
import type { IssuanceRecord } from "../db/repositories/issuances.js";
import type { ClioReader } from "../discovery/types.js";
import { nullLogger, type Logger } from "../logging/logger.js";
import { BalanceDeltaRepository, deltaDeriver, trackedIssuance } from "../reconcile/index.js";
import { decodeMptIssuer } from "../xrpl/mpt.js";

import { noopActivityTracker, type ActivityTracker } from "./activity.js";

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
