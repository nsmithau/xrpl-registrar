# ADR-014: Resolve ledger close times lazily, not eagerly at ingest

## Context

Time-based reporting (`archive_balance_at` by `date`, `archive_transactions` by
`from_time`/`to_time`) needs a timestamp → ledger
mapping, which comes from ledger close times. These were captured eagerly: after
every backfill, one upstream `ledger` call per distinct in-scope ledger. For a
token with a long history that is O(ledgers) calls — the dominant upstream load
after the per-holder backfill was removed (ADR-013) — paid whether or not anyone
ever queries by time, and most operators query by ledger.

## Decision

Do not capture close times eagerly. Resolve a timestamp to a ledger **on demand**
by binary-searching the archive's ledger-index range, fetching each probed
ledger's close time from Clio (a cheap, locally-answered `ledger` call) and
caching it in `ledgers`. Cost is O(log range) upstream calls on a cold cache, and
zero unless a time query is actually made; probes are cached, so repeated/nearby
time queries reuse them. The live tail still records close times forward as it
runs (free), so recent ranges are usually already cached.

Balances change only at in-scope ledgers, so resolving a timestamp to the ledger
index in effect at it — even a non-archived ledger — and summing deltas up to
that index is exact; the resolved ledger need not itself be archived.

The resolver is injected into `ArchiveApi` (`resolveLedgerTime`). The default is
table-only (cached `ledgers`, no upstream) for offline use and tests; `serve`
injects the lazy Clio-backed resolver. So reporting stays archive-only by default,
and consults upstream only through this one explicit, cached seam.

## Consequences

- Registration no longer makes O(ledgers) `ledger` calls; a token with long
  history registers without a close-time burst.
- A client-less/offline deployment resolves only timestamps the tail has already
  cached; historical time queries there return the honest "no ledger at or before
  time" rather than silently fetching. `serve` (which has upstream) resolves them
  lazily.
- `captureCloseTimes` and its eager call are removed.

## Options Considered

| Option                                              | Verdict                                                                                                             |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Eager per-ledger capture at ingest _(previous)_     | Rejected. O(ledgers) upstream calls paid up front, usually unused.                                                  |
| Background/throttled eager capture                  | Rejected. Still O(ledgers) total; complexity without removing the work.                                             |
| **Lazy binary-search on demand, cached** _(chosen)_ | O(log range) per cold time query, zero otherwise; reporting stays archive-only by default via an injected resolver. |
