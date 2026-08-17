# ADR-012: Tail-driven incremental maintenance, not periodic full re-derivation/re-scan

**Date:** 2026-08-14

## Context

After the initial load, the archive must stay current: pick up new holders, keep
derived balances accurate, and report honest coverage. The first implementation
did this with a periodic re-discovery pass (`REDISCOVERY_INTERVAL_MS`) that re-ran
the whole pipeline per issuance — full discovery scan **and** a full re-derivation
of `balance_deltas` over *every* archived transaction.

This did not scale. For an IOU issuance with ~4.4k accounts and ~2.2M
transactions, each pass re-decoded all 2.2M transaction metadata blobs every
interval. Worse, it was also a **correctness** problem: delta-based reporting
(`archive_balance_at` / `archive_transactions`) was stale between passes — a balance
received via the live tail read `0` even though `account_lines` (reconstructed
live from metadata) returned it correctly — and coverage froze at the backfill
snapshot, understating completeness.

## Decision

Make the **live tail the incremental maintainer**. The tail already sees every
in-scope transaction, so maintenance is event-driven there, not a periodic
O(history) sweep:

1. **Deltas** are derived per transaction at ingest, on the same DB transaction
   as the insert, in every ingest path (backfill, tail, gap heal). The batch
   `deriveMptDeltas`/`deriveIouDeltas` are retained only as a full-rebuild utility.
2. **New holders** are discovered from the stream. The subscription is widened to
   **holders ∪ issuers**: a new holder's first activity (opt-in, issue/redeem)
   routes through the issuer, so subscribing to it surfaces the new holder's
   `MPToken`/`RippleState` node, which is backfilled and added to scope live.
3. **Coverage** advances to the tail's high-water (`max(ledgers.ledger_index)`)
   rather than freezing at the per-account backfill `to_ledger`.

Periodic re-discovery is demoted to an opt-in **safety-net** backstop.

## The point that settles it

Empirically verified on testnet against a test issuer: the
issuer's `account_tx` — exactly what `subscribe accounts:[issuer]` delivers —
contains holder-submitted `MPTokenAuthorize` opt-ins and issue/redeem Payments.
So new holders **are** visible via the issuer subscription; a periodic full
re-scan is not required to find them.

## Options Considered

| Option | Verdict |
|--------|---------|
| Periodic full re-derivation + re-scan | Rejected. O(entire history) per pass; does not scale; leaves reporting stale between passes. |
| **Tail-driven incremental** *(chosen)* | Deltas/discovery/coverage maintained as transactions land. Real-time, scales with *new* activity not total history. |

Holder subscriptions are **retained** alongside the issuer, not replaced by it: a
holder-to-holder MPT transfer need not touch the issuer, so watching each holder
is required for delta completeness and secondary-transfer discovery.

## Consequences

- Ingest paths take a `deriveDeltas` hook (atomic with the insert); `LiveTail`
  gains a post-commit `onTransaction` hook for streaming discovery.
- Initial load is *faster* too: derivation folds into the single backfill pass
  instead of a second full decode.
- A new holder appearing during a tail gap is now also discovered: the gap heal
  runs streaming discovery (`onEntry` → the same holder-detection) over the
  transactions it re-fetches, so the holder is added to scope during the heal
  rather than only by the periodic scan. With that closed, the periodic
  re-discovery is a pure belt-and-suspenders backstop (default 1 h); the residual
  cases it still guards are things like a heal that failed outright.
- The **gap heal fetch strategy** follows from the same "point that settles it":
  because the issuer's `account_tx` contains every in-scope transaction —
  including holder-to-holder transfers where the issuer's own `AccountRoot` is
  untouched — the heal pages `account_tx` on each **issuer** over the gap range
  (`ledger_index_min`/`max`), not a `ledger` fetch per gap ledger nor an
  `account_tx` sweep per holder. Cost is O(in-scope transactions in the gap): a
  short reconnection gap, or three MPTs sharing one issuer, heals in a single
  paginated sweep. `holdersInMeta` is the in-scope filter and also associates the
  transaction with the holders it touches, so discovery and delta derivation are
  unchanged. (Holder-level `account_tx` remains how each newly-discovered holder's
  *pre-gap* history is backfilled — the issuer sweep only covers the gap window.)
- `REDISCOVERY_INTERVAL_MS` becomes a backstop cadence, not the primary mechanism
  (see the default chosen in the env/README).
