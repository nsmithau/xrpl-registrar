/**
 * Balance smoke test: sample N random holders of an issuance and check the
 * balance the archive reports against the holder's actual on-chain balance at
 * the same ledger (latest validated if unset). Exits non-zero on any mismatch —
 * usable as a deployment/CI health check.
 *
 *   ISSUANCE=<id | mpt_id | CURRENCY/ISSUER> [SAMPLE=10] [LEDGER=<n>] pnpm verify
 *
 * Talks to a RUNNING server over HTTP (it never opens the database directly —
 * the embedded PGlite store is single-writer, so a second opener would abort).
 * Uses:
 *   - the admin API (holder sample + issuance list),  ADMIN_URL / ADMIN_TOKEN
 *   - the read API (`archive_balance_at`),             READ_URL
 *   - upstream Clio (on-chain balance),                CLIO_ENDPOINT
 *
 * ADMIN_URL/READ_URL default to the loopback admin/read ports. ADMIN_TOKEN is
 * required (the holder sample is admin-only). Start the server first (`pnpm
 * serve` / the systemd service).
 */
import Big from "big.js";

import type { ClioClient } from "../src/clio/client.js";
import { createClioClient, loadConfig } from "../src/index.js";
import { currencyToString } from "../src/xrpl/currency.js";

interface IssuanceInfo {
  readonly id: number;
  readonly kind: "mpt" | "iou";
  readonly mptIssuanceId: string | null;
  readonly currency: string | null;
  readonly issuerAccount: string | null;
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

/** The account does not exist on-ledger at the queried ledger — e.g. a holder
 * that was later deleted (AccountDelete). The archive keeps it (append-only),
 * but on-chain it holds nothing, so its balance is 0. */
function isActNotFound(err: unknown): boolean {
  return asRecord(err)["code"] === "actNotFound";
}

/** GET the admin API with the bearer token. */
async function adminGet(
  adminUrl: string,
  token: string,
  path: string,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${adminUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`admin ${path} → HTTP ${res.status}`);
  return asRecord(await res.json());
}

/** The archive's balance for a holder as of `ledger`, via the read API's
 * `archive_balance_at` (the same computation `pnpm verify` would do in SQL, but
 * served by the running process that owns the database). */
async function archiveBalance(
  readUrl: string,
  issuanceId: number,
  account: string,
  ledger: number,
): Promise<Big> {
  const res = await fetch(readUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      method: "archive_balance_at",
      params: [{ issuance_id: issuanceId, account, ledger_index: ledger, api_version: 2 }],
    }),
  });
  const result = asRecord(asRecord(await res.json())["result"]);
  if (result["status"] !== "success") {
    throw new Error(`archive_balance_at failed: ${JSON.stringify(result["error"] ?? result)}`);
  }
  return new Big(typeof result["balance"] === "string" ? result["balance"] : "0");
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

/** On-chain IOU balance (holder's perspective) at `ledger`, via account_lines. */
async function chainIouBalance(
  client: ClioClient,
  holder: string,
  issuer: string,
  currency: string,
  ledger: number,
): Promise<Big> {
  try {
    const res = await client.request<{
      lines?: Array<{ account?: string; balance?: string; currency?: string }>;
    }>({
      command: "account_lines",
      account: holder,
      peer: issuer,
      ledger_index: ledger,
    });
    for (const line of res.result.lines ?? []) {
      if (
        line.account === issuer &&
        line.currency &&
        currencyToString(line.currency) === currency
      ) {
        return new Big(line.balance ?? "0");
      }
    }
    return new Big(0); // no trustline at that ledger → holds nothing
  } catch (err) {
    if (isActNotFound(err)) return new Big(0); // account gone at this ledger
    throw err;
  }
}

/** On-chain MPT balance at `ledger`, via account_objects (filtered to the MPT). */
async function chainMptBalance(
  client: ClioClient,
  holder: string,
  mptIssuanceId: string,
  ledger: number,
): Promise<Big> {
  try {
    const res = await client.request<{ account_objects?: unknown[] }>({
      command: "account_objects",
      account: holder,
      ledger_index: ledger,
    });
    for (const raw of res.result.account_objects ?? []) {
      const o = asRecord(raw);
      if (o["LedgerEntryType"] === "MPToken" && o["MPTokenIssuanceID"] === mptIssuanceId) {
        return new Big(typeof o["MPTAmount"] === "string" ? o["MPTAmount"] : 0);
      }
    }
    return new Big(0); // no MPToken at that ledger → holds nothing
  } catch (err) {
    if (isActNotFound(err)) return new Big(0); // account gone at this ledger
    throw err;
  }
}

/** Resolve the ISSUANCE spec against the admin issuance list. */
function matchIssuance(list: IssuanceInfo[], spec: string): IssuanceInfo | undefined {
  if (/^\d+$/.test(spec)) return list.find((i) => i.id === Number(spec));
  if (spec.includes("/")) {
    const slash = spec.indexOf("/");
    const currency = currencyToString(spec.slice(0, slash));
    const issuer = spec.slice(slash + 1);
    return list.find(
      (i) => i.kind === "iou" && i.currency === currency && i.issuerAccount === issuer,
    );
  }
  return list.find((i) => i.mptIssuanceId === spec);
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
  const adminToken = config.admin.token;
  if (!adminToken) {
    console.error("ADMIN_TOKEN is required (the holder sample is admin-only).");
    process.exit(2);
  }
  const adminUrl =
    process.env.ADMIN_URL?.replace(/\/+$/, "") ?? `http://127.0.0.1:${config.admin.port}`;
  const readUrl =
    process.env.READ_URL?.replace(/\/+$/, "") ?? `http://127.0.0.1:${process.env.PORT ?? 51234}`;

  const { client } = createClioClient(config);
  await client.connect();

  try {
    const listed = (await adminGet(adminUrl, adminToken, "/admin/issuances"))["issuances"];
    const list = (Array.isArray(listed) ? listed : []).map((r) => {
      const o = asRecord(r);
      return {
        id: Number(o["id"]),
        kind: o["kind"] as "mpt" | "iou",
        mptIssuanceId: (o["mptIssuanceId"] as string | null) ?? null,
        currency: (o["currency"] as string | null) ?? null,
        issuerAccount: (o["issuerAccount"] as string | null) ?? null,
      } satisfies IssuanceInfo;
    });
    const issuance = matchIssuance(list, spec);
    if (!issuance) {
      console.error(`No issuance matches "${spec}" (server knows ${list.length}).`);
      process.exit(2);
    }

    const ledger = process.env.LEDGER
      ? Number(process.env.LEDGER)
      : await latestValidatedLedger(client);
    const label =
      issuance.kind === "mpt"
        ? issuance.mptIssuanceId
        : `${issuance.currency}/${issuance.issuerAccount}`;

    const holdersRes = await adminGet(
      adminUrl,
      adminToken,
      `/admin/issuances/${issuance.id}/holders?limit=${sample}`,
    );
    const holders = (Array.isArray(holdersRes["holders"]) ? holdersRes["holders"] : []).filter(
      (h): h is string => typeof h === "string",
    );

    console.log(`Verifying ${holders.length} random holder(s) of ${label} at ledger ${ledger}\n`);
    if (holders.length === 0) {
      console.log("No holders in scope for this issuance — nothing to check.");
      process.exit(0);
    }

    let mismatches = 0;
    for (const holder of holders) {
      const dbBal = await archiveBalance(readUrl, issuance.id, holder, ledger);
      const chainBal =
        issuance.kind === "mpt"
          ? await chainMptBalance(client, holder, issuance.mptIssuanceId ?? "", ledger)
          : await chainIouBalance(
              client,
              holder,
              issuance.issuerAccount ?? "",
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
        "A mismatch can mean incomplete coverage at this ledger (still backfilling/healing) or a real gap. " +
          "Check the issuance's coverage range via the admin API.",
      );
    }
    process.exit(mismatches > 0 ? 1 : 0);
  } finally {
    await client.disconnect();
  }
}

await main();
