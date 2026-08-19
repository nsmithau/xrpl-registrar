# ADR-017: Serve `gateway_balances` for IOU issuers — scoped and fail-closed

**Status:** Proposed. Decider: Neil Smith.

## Context

The read API mirrors Clio for the methods a reporting client actually calls
(ADR-004): `account_tx`, `tx`, `account_info`, `account_lines`, `mpt_holders`,
plus the namespaced reporting extensions `archive_balance_at` /
`archive_transactions`. For an **MPT** issuance, `mpt_holders` gives the
issuer-level view — every current holder and their amount. For an **IOU**
issuance there is no equivalent issuer-level aggregate: a client wanting "how
much of this token is in circulation" today has to enumerate `account_lines` on
the issuer and sum the balances itself.

`gateway_balances` is the Clio method that answers exactly that. Given an issuer
`account` (and optional `hotwallet` list and `ledger_index`) it returns:

- `obligations` — total amount the gateway owes, per currency (the tokens in
  circulation);
- `balances` — amounts held by designated hot-wallet accounts, broken out
  separately;
- `assets` — tokens the gateway itself _holds_ that were **issued by others**;
- the echoed `ledger_index` / `ledger_hash`.

We already have the primitives to compute the first two from the archive:
[`reconcile/iou.ts`](../../src/reconcile/iou.ts) reconstructs per-holder IOU
balances from the `RippleState` metadata, and `archive_balance_at` already
resolves balances **as of a ledger**. `obligations` for a registered issuance is
just the sum of every in-scope holder's balance — and because the archive's
whole guarantee is a _complete_ holder set, that sum equals the true circulating
total. So the arithmetic is easy; the decision is about **scope and honesty**,
not computation.

The tension: `gateway_balances` is keyed by **issuer account** and is
**multi-currency** (one issuer may issue several currencies), whereas the archive
is scoped per **issuance** — a `(currency, issuer)` pair. A naive
implementation would return an `obligations` map that looks authoritative but
silently omits any currency the operator did not register. That is precisely the
worst failure mode the system exists to avoid (non-negotiable principle #1: never
a plausible wrong answer; #3: distinguish "not in the archive" from "does not
exist"; #4: coverage is a separate claim from membership).

## Decision

Add `gateway_balances` as an **archive-scoped, scope-checked read method**
(`api_version: 2` only, like the rest). Compute it from the archive, never
forward it upstream.

1. **`obligations`.** For each **registered, enabled IOU issuance whose issuer is
   the requested `account`**, report the currency and the total in circulation —
   the sum of every in-scope holder's reconstructed balance for that issuance
   (positive; the issuer's liability). Resolve as of the requested `ledger_index`
   via the same as-of path as `archive_balance_at`; default to the archive's
   latest validated ledger.

2. **Fail closed on scope.** If `account` is **not** the issuer of any registered
   IOU issuance, return **`notInArchive`** — never `actNotFound` (that would
   assert the account does not exist on-ledger, which we do not know), and never
   an empty `obligations: {}` (that would assert "issues nothing", which we also
   do not know). If a registered currency's **coverage does not include the
   requested ledger**, that currency is an error condition, not a silent omission:
   the response must not present a partial map as complete.

3. **`hotwallet`.** Honour the parameter: a holder named in `hotwallet` is pulled
   out of `obligations` and reported under `balances` instead, matching Clio.

4. **`assets` — explicitly not tracked.** The archive tracks the issuer _as an
   issuer_, not as a _holder_ of third-party tokens, so it cannot compute `assets`
   completely. We therefore **do not fabricate it**: the field is omitted (not
   returned as `{}`, which would read as "holds none"), and every response
   carries the filtered-archive status warning (ADR-006) noting that this method
   reports issuer obligations/balances from the archive and does **not** report
   the issuer's own holdings. Honesty over drop-in fidelity where the two
   conflict.

Method class is **archive read** (scope-checked), alongside `mpt_holders`. It is
IOU-only: an MPT issuer's aggregate is already `mpt_holders`.

## Consequences

- Restores symmetry: `mpt_holders` for MPT issuers, `gateway_balances` for IOU
  issuers. A client can point `xrpl.js` at the archive and call the method it
  already uses against Clio.
- Reuses `reconcile/iou.ts` reconstruction and the `archive_balance_at` as-of
  machinery; no new ingest or storage surface.
- Correctness rides on complete discovery — the same guarantee every other
  archive read depends on. If discovery is complete, `obligations` is exact; the
  coverage claim is what makes that trustworthy, which is why an out-of-coverage
  ledger must error rather than under-report.
- `assets` is a **documented, surfaced limitation**, not a silent gap. A client
  that genuinely needs the issuer's third-party holdings must query upstream; the
  warning tells them so.
- A multi-currency issuer gets all its **registered** currencies in one call, and
  only those — the response is complete _with respect to the archive's scope_,
  and says so.
- Read cost today is a per-call reconstruction over history (like `mpt_holders`);
  the materialised current-holders / `object_state` projection
  ([ROADMAP #1](../ROADMAP.md)) would make the latest-ledger case an indexed
  `SELECT` and is the natural optimisation once this ships.

## Options considered

| Option                                                                                                | Verdict                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Don't support it; clients sum `account_lines` on the issuer                                           | Rejected. Pushes a correctness-critical aggregation _and_ the coverage judgement onto every client, and drops the drop-in Clio compatibility that is the point of the read API.                                                                               |
| Forward `gateway_balances` upstream to Clio                                                           | Rejected. Defeats the archive's purpose — point-in-time circulation from complete history is exactly what we hold locally — and re-couples a reporting run to the shared upstream (ADR-002/003). Upstream also cannot answer scoped to _our_ coverage claims. |
| Support it, fully mirroring Clio incl. `assets`                                                       | Rejected. We cannot compute `assets` completely (the issuer's third-party holdings are out of scope); returning `assets: {}` as if authoritative violates principle #4.                                                                                       |
| **Obligations + balances, `assets` flagged not-tracked, fail-closed multi-currency scope** _(chosen)_ | Computable exactly from what we hold, honest about the one thing we cannot answer, and fail-closed on unregistered issuers/currencies.                                                                                                                        |
