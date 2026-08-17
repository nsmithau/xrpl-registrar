# ADR-013: Issuer-centric backfill — one `account_tx` sweep per issuer, not per holder

## Context

The initial backfill (ADR-012 left it as-is) did two things per issuance: a
discovery pass to enumerate holders, then a bulk backfill that ran one
`account_tx` sweep **per holder**. For an auth-required MPT this is doubly
wasteful — the authorisation discovery scan already sweeps the issuer's
`account_tx` (which contains every holder's activity), and then the backfill
re-fetches each holder's `account_tx` individually. A token with N holders costs
~N sweeps; three MPTs on one issuer cost 3× that. Against a shared upstream this
is the dominant source of load and gets rate-limited.

## The point that settles it (extends ADR-012)

ADR-012 established that the issuer's `account_tx` contains holder-submitted
`MPTokenAuthorize` opt-ins. The stronger property, verified against the same
testnet issuer: it also contains **holder-to-holder Payments** — a transfer
between two holders appears in the issuer's `account_tx` even though the issuer's
own `AccountRoot` is not in the transaction's `AffectedNodes`. Clio indexes all
MPT/IOU activity against the issuer (the same way `TrustSet` appears in the
issuer's `account_tx` when a holder submits it). So a single `account_tx` sweep
on the issuer is a **complete** source for the whole issuance's history.

## Decision

Backfill an issuance with **one paginated `account_tx` sweep on its issuer**,
bounded by `[backfillFromLedger, ∞)` and resumable via a `kind='issuer'`
`backfill_job`. The sweep both discovers holders (`holdersInMeta` on each entry)
and backfills their history in one pass; there is no separate discovery request
round. Deltas derive per transaction at ingest, as before. The gap heal already
works this way (ADR-012 consequences); backfill and heal now share one mapper
(`issuerSweepEntryMapper`).

**Coverage** is claimed once the sweep completes: it saw every issuer transaction
in `[from, highWater]`, so every holder of the issuance — and the issuer — is
covered across that whole range. Forward pagination means the final page carries
the true high-water even after a resume; holders discovered on each page are
recorded atomically with that page's checkpoint, so a resume never loses one.

## Consequences

- N-holder backfill collapses to one sweep per issuer. The per-holder
  `account_tx` fan-out (`BackfillWorker` over one job per address) is **retained**
  but demoted to the tail's new-holder path: when the tail spots a holder after
  the initial sweep, a single-holder sweep backfills its history and writes its
  coverage row. This is rare (one per new holder) and idempotent.
- `discover()` and its strategies (trustline / authorization / traversal) are no
  longer on the default ingest path. They remain for explicit-strategy use and as
  a cross-check primitive; the issuer sweep subsumes them for the common case and
  is strictly cheaper than traversal.
- **Defence in depth vs ADR-012's hedge.** ADR-012 retained holder subscriptions
  because "a holder-to-holder transfer need not *touch* the issuer." The new
  evidence shows such transfers still *appear in the issuer's `account_tx`*, so
  the issuer sweep is complete for backfill/heal. The live tail nonetheless keeps
  the holder subscriptions (holders ∪ issuers) — cheap insurance against an
  indexing edge case — so the assumption is load-bearing only for the historical
  sweep, where it is backed by direct evidence, not for the live path.
- Resume dispatch splits by job `kind`: the issuer sweep is run explicitly
  (`runIssuerBackfill`); the per-holder claim loop filters to `kind='account'`,
  so it never mistakes an issuer job for a holder job.

## Options Considered

| Option | Verdict |
|--------|---------|
| Per-holder `account_tx` backfill *(previous)* | Rejected. O(holders) sweeps; re-fetches what the discovery sweep already saw; rate-limited on a shared upstream. |
| **Issuer `account_tx` sweep** *(chosen)* | O(in-scope transactions). Discovery and backfill in one pass; one sweep covers every issuance on a shared issuer. |
| Per-ledger `ledger` fetch over full history | Rejected. O(all ledgers since issuance); enormous for a token created long ago. |
