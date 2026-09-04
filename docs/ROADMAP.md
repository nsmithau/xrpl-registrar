# Roadmap

Open, not-yet-committed work. Unlike the [ADRs](adr/) — which record decisions already
made — this is a backlog of things we know we want to do, with enough context and
implication analysis to pick one up cold. Ordered roughly by when it starts to
matter, not strictly by priority. Nothing here is scheduled.

Sizes are rough: **S** a focused change, **M** a new component or a change with a
correctness surface, **L** a cross-cutting change touching several ingest paths or
the storage engine.

---

## 1. Materialised current-holders projection (M–L)

**Why.** `mpt_holders` (and `account_info` / `account_lines`) answer by pulling
_every_ archived transaction's metadata for the issuance, decoding all of it, and
folding it into "latest state per object" in
[`reconstruct.ts`](../src/api/state/reconstruct.ts). Read cost scales with **history
depth**, not with the **answer size**. Fine for shallow history; the bottleneck for a
deep-history issuance (many months of history, thousands of holders), where a single page decodes
the whole history. (`SELECT DISTINCT` over the `meta_blob` bytea was already removed;
this is the remaining cost.)

**What.** Maintain a projection — e.g. `mptoken_state(issuance_id, account,
mptoken_index, mpt_amount, flags, last_ledger, last_tx_index, deleted)` — updated
incrementally at ingest, so a read is a plain indexed `SELECT`. Reads then scale with
holder count, and the `limit`/`marker` pagination becomes a real keyset query
(`WHERE mptoken_index > $marker ORDER BY mptoken_index LIMIT $n`) instead of
load-all-then-slice-in-JS.

**Implications — read these before starting.**

- **Point-in-time is the hard part.** `mpt_holders` accepts `ledger_index` and can
  answer holdership _as of any past ledger_ (it folds up to that ledger). A _current_
  projection only knows "now." Two ways out:
  - **Two-path (recommended):** serve the latest query from the projection; keep the
    reconstruction path for historical `ledger_index` queries. The projection becomes
    an optimisation layer over the reconstruction, which stays the source of truth.
  - **Bitemporal projection:** store per-object valid-from/valid-to. Answers any
    ledger from the table, but it is a much larger, trickier structure — effectively a
    mini ledger-state store. Not worth it unless historical reads are hot.
- **Re-derivability (non-negotiable).** Like `balance_deltas`, the projection is a
  derived table and must be **rebuildable from blobs** (a `rebuild` path) and updated
  **idempotently and order-independently**. Backfill / heal / tail ingest in different
  orders, so the upsert must be "latest by `(ledger_index, transaction_index)` wins"
  and must honour `DeletedNode` _and_ a later re-creation (resurrect). This is exactly
  what `latestObjects` does in one pass — the risk is doing it incrementally under
  out-of-order ingest and re-ingest. Needs adversarial tests: out-of-order pages,
  delete-then-recreate, re-ingest of the same tx.
- **Cross-check.** Add a projection-vs-reconstruction check as a correctness guard; a
  silent divergence would be a "plausible wrong answer," the failure mode the whole
  system is built to avoid.
- **Ingest write cost.** Each ingested tx also upserts the object state for the
  in-scope objects it touches — a little more write work per tx, negligible for small
  issuances, worth it at scale.
- **Scope.** MPT-only (`mpt_holders`) is the smaller first step; a generic
  `object_state` also covering AccountRoot / RippleState serves `account_info` /
  `account_lines` too (more value, more surface).

**Suggested sequencing.** Validate against a real deep-history issuance so the
incremental logic can be diffed against reconstruction output at scale. Build table +
incremental updater + rebuild + cross-check first, prove parity, _then_ switch the
reads over with reconstruction as fallback.

---

## 2. Discovery cross-check (S–M)

**Why.** The old registration path ran a discovery cross-check (compare the derived
account set against current holders via `mpt_holders` / `account_lines` — a correctness
signal, `DiscoveryCrossCheck`). [ADR-013](adr/adr-013-issuer-centric-backfill-one-account-tx-sweep.md)
folded discovery into the issuer sweep and dropped that automatic cross-check;
`discover()` and its strategies remain as a primitive but are off the default path.

**What.** A periodic (or on-demand) check that flags any _current_ holder — from a live
`mpt_holders` / `account_lines` query — missing from the swept set. For regulatory-grade
data, an independent confirmation that the sweep is complete is worth keeping. Low
upstream cost (one issuer-scoped current-state query per issuance). Surface a warning /
metric on mismatch rather than failing.

---

## 3. Networked Postgres + multi-process backfill (L)

**Why.** [ADR-010](adr/adr-010-store-the-filtered-archive-in-postgres-not.md) keeps
storage behind a driver-agnostic interface with PGlite (in-process, single-threaded)
as the default engine. PGlite serialises all work on one thread — fine for a single
issuer, the ceiling for many. The concurrency governor is also in-process only.

**What.** A networked `pg`-backed `Database` implementation behind the same interface,
plus a governor coordinated across workers (parent process or the shared DB) so
multi-process backfill fan-out does not multiply upstream load. This is the real fix
for CPU/throughput at scale, of which the ingest-side optimisations already landed
(decode-once, batched delta inserts) are the in-process half.

---

## 4. Durable ingest trigger (M)

**Why.** Registering an issuance triggers ingestion in an in-process background task; a
crash mid-ingest loses the trigger (the backfill job itself is resumable, but the
_orchestration_ is not durable). `resumeBackfills` on startup covers outstanding jobs,
so this is a robustness gap more than a data-loss one.

**What.** A durable work queue / outbox for ingest orchestration so registration →
ingest survives a restart without relying on the startup resume sweep.

---

## 5. Periodic external reconciliation against upstream (M)

**Why.** The internal reconciler checks derived balances against state reconstructed
from our own metadata. That catches derivation bugs, not _archive incompleteness_ — a
missed transaction is consistent with itself.

**What.** A periodic cross-check of archived balances/holders against a live upstream
query (`mpt_holders` / `account_lines` for current state), reported as a health signal.
Overlaps with item 2; could share machinery.

---

## 6. Ops hardening (M)

**Why.** A native Ubuntu deployment path now ships in [`deploy/`](../deploy/) — a
compiled `node` entrypoint, an idempotent installer, a hardened systemd unit, an
nginx + TLS example, and a runbook covering the exposure model, backups, upgrades and
uninstall — and `HOST` makes the public bind address explicit. What is still missing
is observability and a non-Ubuntu path.

**What.** A metrics endpoint, a container image, and the upstream-replacement
procedure per [ADR-003](adr/adr-003-public-clio-cluster-for-alpha-beta.md).
Prerequisite for anyone running this against a real filing deadline.

---

## 7. Range-sharded issuer sweep (M)

**Why.** The issuer sweep ([ADR-013](adr/adr-013-issuer-centric-backfill-one-account-tx-sweep.md))
pages one `account_tx` marker chain, so its throughput is exactly 1 ÷ page latency
(~1 page/s on public testnet Clio) no matter how large the governor cap is or how well
the HTTP transport ([ADR-016](adr/adr-016-http-transport-for-backfill-paging.md))
parallelises — that parallelism only helps _across_ issuers and holders, not within one
chain. For a busy issuer this is the whole wall-clock: a testnet stablecoin issuer does
more than one transaction per ledger, so a from-genesis sweep is millions of entries
(≈200 per 180 ledgers) walked serially, most of them off-scope for the registered
issuance and discarded after decode.

**What.** Split the sweep's `[from, tip]` into N disjoint ledger windows
(`ledger_index_min`/`max`) and page them concurrently over HTTP, up to the governor cap
— ~N× on this workload. Each shard keeps its own resume marker and checkpoint row, so a
crash resumes every shard from its last page; holders are recorded per page as today.
Coverage is claimed only once **all** shards complete (the floor/high-water rules of
ADR-013 unchanged). Choose N from the range size (one shard for a short heal, up to the
cap for a from-genesis sweep) so small sweeps do not pay the coordination cost.

**Implications.**

- `backfill_job` gains a shard dimension (or a child table) — a job's progress is the
  sum of its shards, and the dashboard progress needs to read it that way.
- The cooperative stop (ADR-018) is per page, so it applies per shard unchanged.
- Idempotent ingest already tolerates two shards touching the same transaction at a
  window boundary; the boundary rule (`min ≤ ledger < max`) should still be exact.
- The per-holder `BackfillWorker` and the gap heal have the same serial-chain shape, but
  their ranges are small; leave them alone unless a heal ever spans a large gap.

---

## Related open questions (from the ADRs)

- **Upstream replacement** before any real filing — [ADR-003](adr/adr-003-public-clio-cluster-for-alpha-beta.md).
- **Repository home** (personal vs XRPLF) and a DCO/CLA for outside contributions —
  [ADR-011](adr/adr-011-license-under-isc.md).
- **A registered XRPLF warning id** for the filtered-archive warning (currently a
  provisional id) — [ADR-006](adr/adr-006-keep-warning-id-2001-add-a-separate.md).
- **UI auth granularity** — the dashboard now signs in with the same admin token
  (`POST /admin/login` → session cookie); a distinct view-only credential is still
  open — [ADR-009](adr/adr-009-operator-ui-is-read-only-and-admin.md).
