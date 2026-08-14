import { nullLogger, type Logger } from "../logging/logger.js";
import { decodeMptIssuer } from "../xrpl/mpt.js";

import { currentTrustlineHolders } from "./accountLines.js";
import { detectRequiresAuth } from "./flags.js";
import { resolveStrategy } from "./resolve.js";
import { authorizationScan } from "./strategies/authScan.js";
import { traversal } from "./strategies/traversal.js";
import { trustlineScan } from "./strategies/trustlineScan.js";
import type {
  ClioReader,
  DiscoveredAccount,
  DiscoveryResult,
  DiscoveryTarget,
} from "./types.js";

export interface DiscoverOptions {
  /**
   * For IOUs, also query current holders via `account_lines` and diff them
   * against the historical set as a cross-check. Default true.
   */
  readonly crossCheck?: boolean;
  /** Logs a `discovery started` / `discovery finished` line around the scan.
   * Defaults to silent. */
  readonly logger?: Logger;
}

function sortByAddress(accounts: DiscoveredAccount[]): DiscoveredAccount[] {
  return [...accounts].sort((a, b) =>
    a.address < b.address ? -1 : a.address > b.address ? 1 : 0,
  );
}

/**
 * Derive an issuance's historical account set.
 *
 * For MPTs in `auto` mode, the require-auth flag is detected on-ledger (unless
 * already supplied) so the authorisation-scan optimisation is used only when it
 * is actually valid; otherwise traversal runs, which is always complete.
 *
 * For IOUs, the authoritative set comes from the historical `TrustSet` scan; a
 * fast `account_lines` query supplies current holders and cross-checks them
 * against it (every current holder must appear in the historical set).
 */
export async function discover(
  client: ClioReader,
  target: DiscoveryTarget,
  options: DiscoverOptions = {},
): Promise<DiscoveryResult> {
  const logger = options.logger ?? nullLogger;
  const label = target.kind === "iou" ? `${target.currency}/${target.issuer}` : target.mptIssuanceId;
  const startedMs = Date.now();
  logger.info("discovery started", { kind: target.kind, target: label });

  const result = await discoverAccounts(client, target, options);

  logger.info("discovery finished", {
    kind: target.kind,
    target: label,
    strategy: result.strategy,
    accounts: result.accounts.length,
    elapsedMs: Date.now() - startedMs,
  });
  return result;
}

async function discoverAccounts(
  client: ClioReader,
  target: DiscoveryTarget,
  options: DiscoverOptions,
): Promise<DiscoveryResult> {
  if (target.kind === "iou") {
    const strategy = resolveStrategy(target);
    if (strategy !== "trustline") {
      throw new Error(`Unsupported IOU discovery strategy: ${strategy}`);
    }

    const historical = await trustlineScan(client, target.currency, target.issuer);
    if (options.crossCheck === false) {
      return { strategy, accounts: historical };
    }

    const current = await currentTrustlineHolders(client, target.issuer, target.currency);
    const historicalSet = new Set(historical.map((a) => a.address));
    const missingFromHistorical = [...current].filter((a) => !historicalSet.has(a)).sort();

    // Union: stay complete even if the historical scan somehow missed a
    // current holder. A non-empty diff is surfaced as a defect signal.
    const accounts =
      missingFromHistorical.length === 0
        ? historical
        : sortByAddress([
            ...historical,
            ...missingFromHistorical.map((address) => ({
              address,
              discoveredVia: "trustline" as const,
              firstAcquisitionLedger: null,
            })),
          ]);

    return {
      strategy,
      accounts,
      crossCheck: {
        method: "account_lines",
        currentCount: current.size,
        missingFromHistorical,
      },
    };
  }

  const issuer = decodeMptIssuer(target.mptIssuanceId);
  const isAuto = target.strategy === undefined || target.strategy === "auto";

  let requiresAuth = target.requiresAuth ?? null;
  if (isAuto && requiresAuth === null) {
    requiresAuth = await detectRequiresAuth(client, target.mptIssuanceId);
  }

  const strategy = resolveStrategy({ ...target, requiresAuth });
  const accounts =
    strategy === "authorization"
      ? await authorizationScan(client, target.mptIssuanceId, issuer)
      : await traversal(client, target.mptIssuanceId, issuer);

  return { strategy, accounts };
}
