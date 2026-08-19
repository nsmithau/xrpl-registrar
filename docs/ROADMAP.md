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

## 3. `gateway_balances` for IOU issuers (M) — [ADR-017](adr/adr-017-gateway-balances-for-iou-issuers.md)

**Why.** `mpt_holders` gives an MPT issuer's issuer-level view, but IOU issuers
have no equivalent aggregate — "how much of this token is in circulation" today
means enumerating `account_lines` on the issuer and summing client-side.
`gateway_balances` is the Clio method for exactly this, and we already hold the
primitives: [`reconcile/iou.ts`](../src/reconcile/iou.ts) reconstructs per-holder
IOU balances, and `archive_balance_at` resolves balances as of a ledger.
`obligations` is then the sum of every in-scope holder's balance — exact, because
the archive's guarantee is a complete holder set.

**What.** Serve `gateway_balances` as an archive-scoped, scope-checked read
(`api_version 2`), computed from the archive, never forwarded. Per ADR-017:
report `obligations` per **registered IOU issuance of the requested issuer**,
honour `hotwallet` (broken out into `balances`), resolve as-of via the
`archive_balance_at` path, and **fail closed** — `notInArchive` for an untracked
issuer, an error (not a silent omission) for a currency whose coverage misses the
requested ledger.

**Implications — read these before starting.**

- **`assets` cannot be answered.** The archive tracks the issuer as an issuer,
  not as a holder of third-party tokens. Omit the field (not `{}`) and surface the
  filtered-archive warning (ADR-006) — honesty over drop-in fidelity. See ADR-017.
- **Multi-currency scope.** One issuer may issue several currencies; report only
  the registered ones, and make the response's scope explicit so a partial map is
  never read as complete.
- **Read cost.** Like `mpt_holders`, a per-call reconstruction over history; the
  materialised current-holders / `object_state` projection ([#1](#1-materialised-current-holders-projection-ml))
  is the natural optimisation for the latest-ledger case once this ships.

---

## 4. Networked Postgres + multi-process backfill (L)

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

## 5. Durable ingest trigger (M)

**Why.** Registering an issuance triggers ingestion in an in-process background task; a
crash mid-ingest loses the trigger (the backfill job itself is resumable, but the
_orchestration_ is not durable). `resumeBackfills` on startup covers outstanding jobs,
so this is a robustness gap more than a data-loss one.

**What.** A durable work queue / outbox for ingest orchestration so registration →
ingest survives a restart without relying on the startup resume sweep.

---

## 6. Periodic external reconciliation against upstream (M)

**Why.** The internal reconciler checks derived balances against state reconstructed
from our own metadata. That catches derivation bugs, not _archive incompleteness_ — a
missed transaction is consistent with itself.

**What.** A periodic cross-check of archived balances/holders against a live upstream
query (`mpt_holders` / `account_lines` for current state), reported as a health signal.
Overlaps with item 2; could share machinery.

---

## 7. Deployment / ops hardening (M)

**Why.** The service binds to localhost and the admin surface must never be publicly
exposed, but there is no packaged deployment story.

**What.** A metrics endpoint, a container image, a runbook (exposure model, backup of
the PGlite file / Postgres, upstream replacement per
[ADR-003](adr/adr-003-public-clio-cluster-for-alpha-beta.md)), and explicit host-binding
configuration. Prerequisite for anyone running this against a real filing deadline.

---

## Related open questions (from the ADRs)

- **Upstream replacement** before any real filing — [ADR-003](adr/adr-003-public-clio-cluster-for-alpha-beta.md).
- **Repository home** (personal vs XRPLF) and a DCO/CLA for outside contributions —
  [ADR-011](adr/adr-011-license-under-apache-2-0.md).
- **A registered XRPLF warning id** for the filtered-archive warning (currently a
  provisional id) — [ADR-006](adr/adr-006-keep-warning-id-2001-add-a-separate.md).
- **UI auth granularity** (inherit admin-port protection vs a distinct login) —
  [ADR-009](adr/adr-009-operator-ui-is-read-only-and-admin.md).
