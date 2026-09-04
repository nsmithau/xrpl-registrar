# ADR-018: Deletable issuances — a bounded exception to append-only

**Status:** Accepted — implemented. Decider: Neil Smith.

## Context

The archive is **append-only** by design: accounts that ever held a token are
never pruned, and raw blobs are retained so everything is re-derivable
(`CLAUDE.md` design principles; the `accounts` table comment says as much).
That is right for the data an issuer is _required to keep_.

But operators need to undo mistakes and reclaim space: an issuance registered
with the wrong id, a test issuance, or a mega-issuer whose from-genesis sweep is
abandoned (e.g. the testnet RLUSD issuer — millions of transactions). Without a
delete, the only recourse is wiping the whole database. So we add a deliberate,
scoped exception.

The hard part is not the SQL but the **data-sharing model**: `transactions` and
`accounts` are deduplicated across issuances (sibling MPTs on one issuer;
holders of several issuances; `TrustSet`s visible in multiple issuers'
`account_tx`). Deleting "an issuance's transactions" must never delete rows
another issuance still needs — that would silently corrupt a _retained_
issuance, the worst failure mode (principle #1).

## Decision

Add `DELETE /admin/issuances/{id}` (admin-authed, like registration). It removes
only rows **exclusive** to the issuance, in one transaction, then `VACUUM`s:

1. Delete rows keyed by the issuance: `balance_deltas`, `backfill_job`,
   `reconciliation_run`, `account_issuance`.
2. Compute the **exclusive accounts** — those in scope for this issuance and no
   other (`account_issuance` `EXCEPT`), plus the issuer account when no other
   issuance uses it as issuer or holder. Delete those accounts and everything
   referencing them (`account_transactions`, `balance_deltas`, `coverage`, jobs).
3. Delete `transactions` left referenced by **no** remaining `account_transactions`
   or `balance_deltas` row. A transaction reachable from a shared issuer or
   another issuance's account is retained.
4. Delete the `issuances` row.
5. `VACUUM (FULL)` (fallback plain `VACUUM`) to reclaim disk — outside the
   transaction, since `VACUUM` cannot run inside one. Best-effort: a compaction
   failure does not undo the delete; the response reports `compacted`.

**Concurrency.** The delete + vacuum takes an exclusive, potentially slow path,
so while it runs the admin server rejects other **mutating** calls
(`POST`/`PATCH`/`DELETE`) with `409 maintenanceInProgress`; reads stay
available.

**Quiesce before purge.** A backfill may still be running for the issuance
(its registration sweep, a startup resume, the periodic re-scan, a per-holder
job, or a gap heal). Before the purge, the admin server awaits an
`onBeforeDelete` hook; in `serve` it drops the issuance from the tracked set (so
the tail stops deriving it and a concurrent refresh cannot re-add it) and flags
it as deleting. Every backfill writer polls that flag inside each page's DB
transaction (ADR-013) and stops at its next page, and gap heals read the tracked
set live per page — so nothing writes rows for the issuance under the purge, and
the DELETE is held for at most one page rather than the remainder of a sweep.
After the purge, `onDeleted` refreshes the tracked set and the live-tail
subscription. If the purge does not happen (unknown id, or a failure),
`onDeleteAborted` lifts the flag so a still-live issuance is not left untracked
until restart.

The response summarises what was removed (`accountsRemoved`,
`transactionsRemoved`, `deltasRemoved`, `compacted`).

## Consequences

- **Append-only is preserved for retained issuances.** The exception is scoped
  to the issuance being deleted; nothing another issuance references is touched.
  This is the whole reason the deletion is exclusive-rows-only rather than a
  blunt "delete all transactions of the issuer."
- **Shared-issuer issuances retain jointly-reachable transactions.** If two
  issuances share an issuer, deleting one keeps transactions still reachable via
  the shared issuer account. This is the safe direction (never delete shared
  data); the trade is that some now-unused rows can linger until the sibling is
  also deleted. Documented so it is not mistaken for a bug.
- **Not for regulatory retention.** This is an operator maintenance tool, not a
  redaction mechanism for data an issuer must keep. Deleting a live, in-use
  issuance destroys its local history (re-derivable only by re-ingesting from
  Clio).
- **The `409` lock is process-local** (a single-node, in-process PGlite
  deployment). A future networked-Postgres/multi-process deployment (ROADMAP)
  would need a shared lock instead.

## Options considered

| Option                                                                          | Verdict                                                                                                                               |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| No delete (stay purely append-only)                                             | Rejected. Leaves "wipe the whole DB" as the only way to undo a mistaken or abandoned issuance, and no way to reclaim disk.            |
| Delete every transaction in the issuer's `account_tx`                           | Rejected. Would delete rows shared with sibling issuances / multi-issuance holders — corrupts a retained issuance (principle #1).     |
| Soft-delete (mark disabled, keep rows)                                          | Rejected for this need: `PATCH {enabled:false}` already pauses an issuance; it does not reclaim space, which is a primary motivation. |
| **Hard delete of exclusive rows + VACUUM, under a maintenance lock** _(chosen)_ | Reclaims space, never removes shared data, and blocks racing mutations during the vacuum.                                             |
