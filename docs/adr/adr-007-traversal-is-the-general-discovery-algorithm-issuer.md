# ADR-007: Traversal is the general discovery algorithm; issuer-scoped queries are optimisations

**Date:** 2026-08-12. **Status:** Amended — the default ingest path is superseded by [ADR-013](adr-013-issuer-centric-backfill-one-account-tx-sweep.md).

> **Amendment note.** ADR-013 established, with live evidence, that the issuer's
> `account_tx` contains *every* in-scope transaction — including holder-to-holder
> transfers on non-auth MPTs, where this ADR assumed no issuer chokepoint. Discovery
> is therefore folded into the single issuer sweep (`holdersInMeta` per page); no
> strategy is selected or run at registration. The strategies below (`discover()`,
> authorisation / trustline / traversal) remain in `src/discovery/` and tested, but
> are off the default path — retained for explicit use and as a cross-check
> primitive. The "run both and diff" cross-check is not automatic; it is
> [ROADMAP #2](../ROADMAP.md). The append-only whitelist and issuance-as-unit
> consequences still stand.

## Context

The driving issuer needs history for **any holder at any time**, not just current holders. `mpt_holders` is point-in-time and cannot answer this. The registrar is generic and must handle issuances beyond any single token.

## Decision

Derive the historical account set per issuance, using a strategy auto-detected from the issuance flags and overridable in config.

| Strategy | Applies to | Method | Cost |
|----------|-----------|--------|------|
| Authorisation scan | MPTs with require-auth | Issuer `account_tx`, `tx_type: MPTokenAuthorize` — every account ever authorised, a safe superset | Low, bounded |
| Trustline scan | All IOUs | Issuer `account_tx`, `tx_type: TrustSet` | Low, bounded |
| Traversal | MPTs without require-auth; universal fallback | From the issuer, follow `mpt_issuance_id`-carrying transactions to counterparties, recursing to closure | Higher |

## Rationale

Traversal is **complete by construction**: every account that ever held the token received it from a prior holder, and every chain originates at a mint from the issuer, so the transfer graph is connected to the issuer. Induction gives completeness.

The issuer-scoped scans are optimisations that work only when the token's structure routes every holder through the issuer. For auth-required MPTs, authorisation is that chokepoint. For IOUs, the trustline is — and `TrustSet` appears in the **issuer's** `account_tx` even when submitted by the holder, confirmed against a live response where a transaction signed by one account was returned under the issuer named in `LimitAmount`.

Non-auth MPTs have no chokepoint, because holder-to-holder transfers never touch the issuer. Traversal is required there.

## Options Considered

| Option | Verdict |
|--------|---------|
| `mpt_holders` sweep only | **Insufficient.** Current holders only; misses anyone who exited before first sync. |
| Full ledger scan from issuance forward | **Rejected.** Complete, but reads every transaction in every ledger since issuance rather than only accounts that actually held. Traversal gets the same completeness at a fraction of the cost. |
| Issuer-scoped scan only | **Rejected as general solution.** Correct for auth-required MPTs and IOUs, silently incomplete for non-auth MPTs. Shipping it alone would make the tool specific to a single issuance. |
| Traversal as base, scans as optimisation *(chosen)* | One general algorithm; short-circuit where flags permit. |

## Consequences

- Where two strategies apply they should produce **identical** sets. Run both and diff — a mismatch is a defect signal, and agreement is a correctness metric.
- XRPScan Console supports full-history search on `MPTokenIssuanceID`, giving an independent third derivation. Valuable as an **audit cross-check**, not as a source of truth: it is third-party and beta, and making it authoritative would reintroduce the external dependency this project removes. Transactions always come from Clio.
- The configuration unit becomes the **issuance**, not the account list. The registrar derives and maintains the account set. Direct account whitelisting survives for non-token cases but is no longer the primary interface.
- The whitelist is **append-only**. Exited holders are never pruned.
- Non-auth MPT backfill is a distinct performance tier. The <24h target applies to issuer-scoped discovery; traversal performance should be published as a measured characteristic rather than promised.
