/**
 * Balance smoke test: sample N random holders of an issuance and check the
 * balance the archive computes (summing `balance_deltas` as of a ledger) against
 * the holder's actual on-chain balance at that same ledger. Exits non-zero if
 * any holder mismatches — usable as a deployment/CI health check.
 *
 *   ISSUANCE=<id | mpt_id | CURRENCY/ISSUER> [SAMPLE=10] [LEDGER=<n>] pnpm verify
 *
 * - ISSUANCE: the archive's numeric issuance id, or an MPT's 48-hex id, or an
 *   IOU as "CURRENCY/ISSUER" (e.g. "RLUSD/rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV").
 * - SAMPLE:   how many random holders to check (default 10).
 * - LEDGER:   the ledger to compare at (default: the latest validated ledger).
 *
 * Requires a populated DATABASE_DIR and a full-history CLIO_ENDPOINT (so it can
 * read historical balances). The archive balance is the same computation the
 * `archive_balance_at` reporting method uses.
 */
import Big from "big.js";

import type { ClioClient } from "../src/clio/client.js";
import type { Database } from "../src/db/database.js";
import { createClioClient, loadConfig, openArchiveDatabase } from "../src/index.js";
import { currencyToString } from "../src/xrpl/currency.js";

interface Issuance {
  readonly id: number;
  readonly kind: "mpt" | "iou";
  readonly mptIssuanceId: string | null;
  readonly currency: string | null;
  readonly issuer: string | null;
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

/** Resolve the ISSUANCE spec (numeric id | 48-hex mpt id | CURRENCY/ISSUER). */
async function resolveIssuance(db: Database, spec: string): Promise<Issuance | null> {
  const cols = "id, kind, mpt_issuance_id, currency, issuer_account";
  let sql: string;
  let params: unknown[];
  if (/^\d+$/.test(spec)) {
    sql = `SELECT ${cols} FROM issuances WHERE id = $1`;
    params = [Number(spec)];
  } else if (spec.includes("/")) {
    const slash = spec.indexOf("/");
    sql = `SELECT ${cols} FROM issuances WHERE kind = 'iou' AND currency = $1 AND issuer_account = $2`;
    params = [currencyToString(spec.slice(0, slash)), spec.slice(slash + 1)];
  } else {
    sql = `SELECT ${cols} FROM issuances WHERE mpt_issuance_id = $1`;
    params = [spec];
  }
  const { rows } = await db.query<{
    id: number | string;
    kind: "mpt" | "iou";
    mpt_issuance_id: string | null;
    currency: string | null;
    issuer_account: string | null;
  }>(sql, params);
  const r = rows[0];
  return r
    ? {
        id: Number(r.id),
        kind: r.kind,
        mptIssuanceId: r.mpt_issuance_id,
        currency: r.currency,
        issuer: r.issuer_account,
      }
    : null;
}

/** The latest validated ledger index the upstream reports. */
async function latestValidatedLedger(client: ClioClient): Promise<number> {
  const res = await client.request<{ info?: { validated_ledger?: { seq?: number } } }>({
    command: "server_info",
  });
  const seq = res.result.info?.validated_ledger?.seq;
  if (typeof seq !== "number")
    throw new Error("could not read the latest validated ledger from server_info");
  return seq;
}

/** N random in-scope holders of the issuance. */
async function sampleHolders(db: Database, issuanceId: number, n: number): Promise<string[]> {
  const { rows } = await db.query<{ address: string }>(
    "SELECT address FROM account_issuance WHERE issuance_id = $1 ORDER BY random() LIMIT $2",
    [issuanceId, n],
  );
  return rows.map((r) => r.address);
}

/** The archive's balance for a holder as of `ledger` — the sum of its deltas up
 * to that ledger (the same computation as `archive_balance_at`). */
async function archiveBalance(
  db: Database,
  issuanceId: number,
  holder: string,
  ledger: number,
): Promise<Big> {
  const { rows } = await db.query<{ bal: string | null }>(
    `SELECT sum(bd.delta::numeric)::text AS bal
     FROM balance_deltas bd JOIN transactions t ON t.hash = bd.hash
     WHERE bd.issuance_id = $1 AND bd.address = $2 AND t.ledger_index <= $3`,
    [issuanceId, holder, ledger],
  );
  return new Big(rows[0]?.bal ?? "0");
}

/** On-chain IOU balance (holder's perspective) at `ledger`, via account_lines. */
async function chainIouBalance(
  client: ClioClient,
  holder: string,
  issuer: string,
  currency: string,
  ledger: number,
): Promise<Big> {
  const res = await client.request<{
    lines?: Array<{ account?: string; balance?: string; currency?: string }>;
  }>({
    command: "account_lines",
    account: holder,
    peer: issuer,
    ledger_index: ledger,
  });
  for (const line of res.result.lines ?? []) {
    if (line.account === issuer && line.currency && currencyToString(line.currency) === currency) {
      return new Big(line.balance ?? "0");
    }
  }
  return new Big(0); // no trustline at that ledger → holds nothing
}

/** On-chain MPT balance at `ledger`, via account_objects (filtered to the MPT). */
async function chainMptBalance(
  client: ClioClient,
  holder: string,
  mptIssuanceId: string,
  ledger: number,
): Promise<Big> {
  const res = await client.request<{ account_objects?: unknown[] }>({
    command: "account_objects",
    account: holder,
    ledger_index: ledger,
  });
  for (const raw of res.result.account_objects ?? []) {
    const o = asRecord(raw);
    if (o["LedgerEntryType"] === "MPToken" && o["MPTokenIssuanceID"] === mptIssuanceId) {
      return new Big(
        typeof o["MPTAmount"] === "string" ? o["MPTAmount"] : ((o["MPTAmount"] as number) ?? 0),
      );
    }
  }
  return new Big(0); // no MPToken at that ledger → holds nothing
}

async function main(): Promise<void> {
  const spec = process.env.ISSUANCE?.trim();
  if (!spec) {
    console.error(
      'Set ISSUANCE=<id | mpt_id | CURRENCY/ISSUER>. e.g. ISSUANCE="RLUSD/rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV" pnpm verify',
    );
    process.exit(2);
  }
  const sample = Math.max(1, Number(process.env.SAMPLE ?? 10));

  const config = loadConfig();
  const db = await openArchiveDatabase(
    config.db.dataDir !== undefined ? { dataDir: config.db.dataDir } : {},
  );
  const { client } = createClioClient(config);
  await client.connect();

  try {
    const issuance = await resolveIssuance(db, spec);
    if (!issuance) {
      console.error(`No issuance matches "${spec}" in the archive.`);
      process.exit(2);
    }

    const ledger = process.env.LEDGER
      ? Number(process.env.LEDGER)
      : await latestValidatedLedger(client);
    const label =
      issuance.kind === "mpt" ? issuance.mptIssuanceId : `${issuance.currency}/${issuance.issuer}`;
    const holders = await sampleHolders(db, issuance.id, sample);

    console.log(`Verifying ${holders.length} random holder(s) of ${label} at ledger ${ledger}\n`);
    if (holders.length === 0) {
      console.log("No holders in scope for this issuance — nothing to check.");
      process.exit(0);
    }

    let mismatches = 0;
    for (const holder of holders) {
      const dbBal = await archiveBalance(db, issuance.id, holder, ledger);
      const chainBal =
        issuance.kind === "mpt"
          ? await chainMptBalance(client, holder, issuance.mptIssuanceId ?? "", ledger)
          : await chainIouBalance(
              client,
              holder,
              issuance.issuer ?? "",
              issuance.currency ?? "",
              ledger,
            );
      const ok = dbBal.eq(chainBal);
      if (!ok) mismatches += 1;
      console.log(
        `  ${ok ? "✓" : "✗"} ${holder}  archive=${dbBal.toString()}  chain=${chainBal.toString()}` +
          (ok ? "" : `  DIFF=${dbBal.minus(chainBal).toString()}`),
      );
    }

    const matched = holders.length - mismatches;
    console.log(
      `\n${matched}/${holders.length} matched${mismatches ? `, ${mismatches} MISMATCH` : ""}.`,
    );
    if (mismatches > 0) {
      console.log(
        "A mismatch can mean incomplete coverage at this ledger (the archive is still backfilling/healing), " +
          "or a real gap. Check the issuance's coverage range in the admin API.",
      );
    }
    process.exit(mismatches > 0 ? 1 : 0);
  } finally {
    await client.disconnect();
    await db.close();
  }
}

await main();
