import { decode, hashes } from "xrpl";

import type { Provenance } from "../clio/types.js";
import type { Database, Queryable } from "../db/database.js";
import {
  BackfillJobRepository,
  checkpointJob,
  completeJob,
  type BackfillJob,
} from "../db/repositories/backfillJobs.js";
import { insertTransactionRowsMany, type IngestTransaction } from "../db/repositories/transactions.js";
import { asRecord } from "../discovery/fields.js";
import type { ClioReader } from "../discovery/types.js";
import { nullLogger, type Logger } from "../logging/logger.js";
import { holdersInMeta, type DecodedMeta, type DeriveDeltas, type TrackedIssuance } from "../reconcile/incremental.js";
import { hexToBytes } from "../util/hex.js";

import { accountTxPages, type BinaryTxEntry } from "./pages.js";

/** Emit a running progress counter at most every this many transactions. */
const PROGRESS_EVERY = 1000;

/** A kept entry: the ingestable row plus its decoded metadata, decoded once and
 * reused for both holder detection and delta derivation. */
export interface MappedEntry {
  readonly row: IngestTransaction;
  readonly meta: DecodedMeta;
}

/**
 * Map a binary issuer `account_tx` entry to an ingestable row (with its decoded
 * metadata), keeping it only if it touches a holder of one of `tracked`.
 *
 * Clio indexes all MPT/IOU activity against the issuer — including
 * holder-to-holder transfers where the issuer's own `AccountRoot` is untouched —
 * and every such transaction modifies a holder's `MPToken` / `RippleState` node,
 * so `holdersInMeta` is a complete in-scope filter. The transaction is
 * associated with the issuer (mirroring Clio's own index) plus every
 * tracked-issuance holder it touches, so a single issuer sweep both discovers
 * holders and backfills their history. The metadata is decoded once here and
 * returned so the caller need not decode it again to derive deltas. Shared by
 * the tail's gap heal.
 */
export function issuerSweepEntryMapper(
  tracked: readonly TrackedIssuance[],
): (entry: BinaryTxEntry, issuer: string, provenance: Provenance) => MappedEntry | null {
  return (entry, issuer, provenance) => {
    const meta = asRecord(decode(entry.meta_blob)) ?? null;
    const holders = meta ? holdersInMeta(meta, tracked) : [];
    if (holders.length === 0) return null; // the issuer's unrelated / off-scope activity
    const tx = decode(entry.tx_blob) as { TransactionType?: string };
    return {
      row: {
        hash: hashes.hashSignedTx(entry.tx_blob),
        ledgerIndex: entry.ledger_index,
        txType: tx.TransactionType ?? "unknown",
        mptIssuanceId: null,
        txBlob: hexToBytes(entry.tx_blob),
        metaBlob: hexToBytes(entry.meta_blob),
        provenance,
        accounts: [...new Set([issuer, ...holders.map((h) => h.holder)])],
      },
      meta,
    };
  };
}

export interface IssuerBackfillOptions {
  readonly logger?: Logger;
  /** Derive each transaction's balance deltas as it is ingested, on the same DB
   * transaction as the insert. Default: none. */
  readonly deriveDeltas?: DeriveDeltas;
  /** `account_tx` page size requested from upstream. */
  readonly pageLimit?: number;
  /** Override the entry → row mapping (defaults to decoding binary blobs and
   * scoping to tracked-issuance holders). Injectable for tests. */
  readonly mapEntry?: (entry: BinaryTxEntry, issuer: string, provenance: Provenance) => MappedEntry | null;
  /** Cooperative stop, polled at the top of each page's DB transaction (so a
   * true answer is seen before any further row is written). When it returns
   * true the sweep ends without completing the job or claiming coverage —
   * used to abandon a sweep for an issuance being deleted. */
  readonly shouldStop?: () => boolean;
}

export interface IssuerBackfillResult {
  readonly ingested: number;
  readonly holders: number;
  readonly highWater: number;
}

/**
 * Backfill an issuance by a single paginated `account_tx` sweep on its issuer.
 *
 * This replaces the previous one-`account_tx`-sweep-per-holder fan-out: because
 * every in-scope transaction appears in the issuer's `account_tx`, one bounded,
 * resumable sweep discovers every holder **and** backfills their full history,
 * so three MPTs sharing an issuer, or a token with thousands of holders, cost a
 * single sweep instead of N.
 *
 * Each page commits its rows, deltas, resume marker, and the holders discovered
 * on it in one DB transaction — a crash resumes from the last persisted page
 * with no gaps or duplicates (ingest is idempotent). Coverage is claimed on the
 * final page for every holder and the issuer (see `claimCoverage` for the bounds).
 */
export async function runIssuerBackfill(
  client: ClioReader,
  db: Database,
  issuance: TrackedIssuance,
  job: BackfillJob,
  options: IssuerBackfillOptions = {},
): Promise<IssuerBackfillResult> {
  const logger = options.logger ?? nullLogger;
  const deriveDeltas = options.deriveDeltas ?? (() => Promise.resolve());
  const mapEntry = options.mapEntry ?? issuerSweepEntryMapper([issuance]);
  const shouldStop = options.shouldStop ?? (() => false);
  const jobs = new BackfillJobRepository(db);
  const issuer = job.address;
  const fromLedger = job.fromLedger ?? 0;

  let ingested = 0;
  let highWater = fromLedger;
  let lastProgress = 0;

  try {
    for await (const page of accountTxPages(client, {
      account: issuer,
      fromLedger: fromLedger > 0 ? fromLedger : undefined,
      startMarker: job.lastMarker,
      limit: options.pageLimit,
    })) {
      const batch: MappedEntry[] = [];
      const firstLedger = new Map<string, number>();
      for (const entry of page.entries) {
        const mapped = mapEntry(entry, issuer, page.provenance);
        if (!mapped) continue;
        batch.push(mapped);
        const { row } = mapped;
        if (row.ledgerIndex > highWater) highWater = row.ledgerIndex;
        for (const account of row.accounts) {
          if (account === issuer) continue;
          const prev = firstLedger.get(account);
          if (prev === undefined || row.ledgerIndex < prev) firstLedger.set(account, row.ledgerIndex);
        }
      }
      const isFinal = page.marker === undefined;

      let stopped = false;
      await db.transaction(async (t) => {
        // Checked while holding the (single) writer: a delete sets its flag before
        // it purges, so a false here means the purge cannot land until we commit.
        if (shouldStop()) {
          stopped = true;
          return;
        }
        if (batch.length > 0) {
          await insertTransactionRowsMany(t, batch.map((b) => b.row));
          for (const b of batch) {
            await deriveDeltas(t, b.row.hash, b.meta);
            ingested += 1;
          }
        }
        // Record holders discovered on this page atomically with the checkpoint,
        // so a resume never loses a discovery made before the crash.
        for (const [holder, ledger] of firstLedger) await recordHolder(t, issuance.id, holder, ledger);
        await checkpointJob(t, job.id, page.marker, batch.length);
        if (isFinal) {
          await claimCoverage(t, issuance.id, issuer, fromLedger, highWater);
          await completeJob(t, job.id);
        }
      });
      if (stopped) {
        // Left `running`; a later resume reclaims it if the issuance survives.
        logger.info("issuer backfill stopped", { issuer, ingested });
        break;
      }

      if (ingested - lastProgress >= PROGRESS_EVERY) {
        lastProgress = ingested;
        logger.info("issuer backfill progress", { issuer, ingested });
      }
    }
  } catch (err) {
    await jobs.fail(job.id);
    throw err;
  }

  const holders = await countHolders(db, issuance.id);
  logger.info("issuer backfill finished", { issuer, ingested, holders, highWater });
  return { ingested, holders, highWater };
}

/** Upsert a discovered holder (earliest ledger wins), atomic with the caller's
 * transaction. Mirrors `AccountRepository.recordDiscovered` for one holder. */
async function recordHolder(t: Queryable, issuanceId: number, address: string, ledger: number): Promise<void> {
  await t.query(
    `INSERT INTO accounts (address, first_seen_ledger) VALUES ($1, $2)
     ON CONFLICT (address) DO UPDATE
       SET first_seen_ledger = LEAST(accounts.first_seen_ledger, EXCLUDED.first_seen_ledger)`,
    [address, ledger],
  );
  await t.query(
    `INSERT INTO account_issuance (address, issuance_id, discovered_via, first_acquisition_ledger)
     VALUES ($1, $2, 'issuer_sweep', $3)
     ON CONFLICT (address, issuance_id) DO UPDATE
       SET first_acquisition_ledger =
         LEAST(account_issuance.first_acquisition_ledger, EXCLUDED.first_acquisition_ledger)`,
    [address, issuanceId, ledger],
  );
}

/** Claim coverage for every holder of the issuance plus the issuer: the
 * completed sweep saw all issuer activity across the range.
 *
 * The upper bound is `to` (the sweep's high-water mark). The lower bound is the
 * earliest in-scope transaction the sweep actually stored — `recordHolder`
 * persists each holder's first kept ledger page by page, including zero-delta
 * opt-ins — rather than the configured `from`, so a DB that lost its early rows
 * reports coverage from where the archive really begins instead of silently
 * over-claiming (and every stored row stays inside the claimed range). Clamped
 * to `to` so a resume that re-saw no in-scope rows cannot invert the range. The
 * `reason` keeps the configured range for provenance. */
async function claimCoverage(
  t: Queryable,
  issuanceId: number,
  issuer: string,
  from: number,
  to: number,
): Promise<void> {
  const floorRes = await t.query<{ lo: number | string | null }>(
    "SELECT min(first_acquisition_ledger) AS lo FROM account_issuance WHERE issuance_id = $1",
    [issuanceId],
  );
  const lo = floorRes.rows[0]?.lo;
  const floor = Math.min(to, lo === null || lo === undefined ? from : Math.max(from, Number(lo)));
  const reason = `issuer sweep ${issuer} [${from},${to}]`;
  await t.query(
    `INSERT INTO coverage (address, from_ledger, to_ledger, reason)
     SELECT address, $2, $3, $4 FROM account_issuance WHERE issuance_id = $1`,
    [issuanceId, floor, to, reason],
  );
  await t.query(
    `INSERT INTO coverage (address, from_ledger, to_ledger, reason) VALUES ($1, $2, $3, $4)`,
    [issuer, floor, to, reason],
  );
}

async function countHolders(db: Database, issuanceId: number): Promise<number> {
  const { rows } = await db.query<{ n: number | string }>(
    "SELECT count(*)::int AS n FROM account_issuance WHERE issuance_id = $1",
    [issuanceId],
  );
  return Number(rows[0]?.n ?? 0);
}
