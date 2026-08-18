import { asRecord } from "../discovery/fields.js";
import { holdersInMeta, type TrackedIssuance } from "../reconcile/incremental.js";
import { decodeMptIssuer } from "../xrpl/mpt.js";

/** The issuer address for a tracked issuance. */
function issuerOf(iss: TrackedIssuance): string {
  return iss.kind === "mpt" ? decodeMptIssuer(iss.mptIssuanceId ?? "") : (iss.issuer ?? "");
}

/**
 * Issuance-scoped tail filter: the in-scope accounts a streamed transaction
 * touches *for the tracked issuances* — the holders whose `MPToken` /
 * `RippleState` node it modifies (via {@link holdersInMeta}), plus each matched
 * issuance's issuer (mirroring Clio's `account_tx` index and the backfill/heal
 * association).
 *
 * Returns empty when the transaction touches no tracked issuance, so the live
 * tail ingests only issuance-relevant activity — not a subscribed holder's
 * unrelated `TrustSet`s, XRP payments, or other tokens. This is the same filter
 * the backfill sweep and gap heal use; it replaces the previous account-scoped
 * `affectedAccounts` filter, which admitted any transaction touching a
 * subscribed account regardless of relevance.
 *
 * `tracked` is a getter because the set grows as issuances register.
 */
export function issuanceScope(
  tracked: () => readonly TrackedIssuance[],
): (txJson: unknown, meta: unknown) => string[] {
  return (_txJson, meta) => {
    const decoded = asRecord(meta);
    if (!decoded) return [];
    const list = tracked();
    const holders = holdersInMeta(decoded, list);
    if (holders.length === 0) return [];

    const byId = new Map(list.map((iss) => [iss.id, iss]));
    const accounts = new Set<string>();
    for (const h of holders) {
      accounts.add(h.holder);
      const iss = byId.get(h.issuanceId);
      if (iss) accounts.add(issuerOf(iss));
    }
    return [...accounts];
  };
}
