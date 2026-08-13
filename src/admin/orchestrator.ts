import { captureCloseTimes } from "../backfill/closeTimes.js";
import { BackfillWorker } from "../backfill/worker.js";
import type { Database } from "../db/database.js";
import { AccountRepository } from "../db/repositories/accounts.js";
import type { IssuanceRecord } from "../db/repositories/issuances.js";
import { discover, type DiscoveryTarget } from "../discovery/index.js";
import type { ClioReader } from "../discovery/types.js";
import { nullLogger, type Logger } from "../logging/logger.js";
import { deriveIouDeltas, deriveMptDeltas } from "../reconcile/index.js";

export interface IngestSummary {
  readonly strategy: string;
  readonly discovered: number;
  readonly jobsProcessed: number;
  readonly deltaRows: number;
}

/** The transport the orchestrator needs: governed reads plus connect/disconnect
 * are managed by the caller. */
export type OrchestratorClient = ClioReader;

function targetFor(issuance: IssuanceRecord): DiscoveryTarget {
  const strategy =
    issuance.discoveryStrategy === "auto"
      ? undefined
      : (issuance.discoveryStrategy as DiscoveryTarget["strategy"]);
  if (issuance.kind === "mpt") {
    return {
      kind: "mpt",
      mptIssuanceId: issuance.mptIssuanceId ?? "",
      ...(strategy ? { strategy } : {}),
    };
  }
  return {
    kind: "iou",
    currency: issuance.currency ?? "",
    issuer: issuance.issuerAccount ?? "",
    ...(strategy ? { strategy } : {}),
  };
}

/**
 * Run the ingestion pipeline for a registered issuance: discover the account
 * set, record it, backfill each account (bounded and resumable), then derive
 * balance deltas. Ties the components together behind one call so the admin
 * layer can trigger ingestion on registration.
 */
export async function ingestIssuance(
  client: OrchestratorClient,
  db: Database,
  issuance: IssuanceRecord,
  logger: Logger = nullLogger,
): Promise<IngestSummary> {
  const result = await discover(client, targetFor(issuance));
  await new AccountRepository(db).recordDiscovered(issuance.id, result.accounts);

  const acquisitionLedgers = result.accounts
    .map((a) => a.firstAcquisitionLedger)
    .filter((l): l is number => l !== null && l > 0);
  const fromLedger =
    issuance.backfillFromLedger > 0
      ? issuance.backfillFromLedger
      : acquisitionLedgers.length > 0
        ? Math.min(...acquisitionLedgers)
        : 0;

  const worker = new BackfillWorker({ client, db, logger });
  await worker.enqueue(
    issuance.id,
    result.accounts.map((a) => a.address),
    fromLedger,
  );
  const { processed } = await worker.runIssuance(issuance.id);

  // Capture close times for the ledgers we ingested, enabling time-based
  // reporting later.
  await captureCloseTimes(client, db, issuance.id);

  const deltaRows =
    issuance.kind === "mpt"
      ? await deriveMptDeltas(db, issuance.id, issuance.mptIssuanceId ?? "")
      : await deriveIouDeltas(db, issuance.id, issuance.currency ?? "", issuance.issuerAccount ?? "");

  logger.info("issuance ingested", {
    issuanceId: issuance.id,
    strategy: result.strategy,
    discovered: result.accounts.length,
    jobsProcessed: processed,
    deltaRows,
  });

  return {
    strategy: result.strategy,
    discovered: result.accounts.length,
    jobsProcessed: processed,
    deltaRows,
  };
}
