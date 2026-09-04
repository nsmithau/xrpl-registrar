# ADR-010: Store the filtered archive in Postgres, not Clio's Scylla/Cassandra backend

**Date:** 2026-08-12

## Context

Clio stores the full XRPL history in ScyllaDB (Cassandra-compatible). Since we source everything from Clio, the natural question is whether to match its backend — reuse Clio's proven data model, share operational know-how, keep the door open to feeding a Clio instance directly.

`docs/architecture.md` already assumes Postgres, but the choice was never defended against Scylla in a decision record. This ADR does that, because "the source of truth uses Scylla" is a reasonable-sounding reason to reach for it, and the reasons not to are invisible from the call site.

## Decision

Store the archive in **Postgres**. For development, test, and small single-issuer deployments, run it **in-process via [PGlite](https://pglite.dev/)** — a real Postgres (WASM) with the genuine SQL dialect, no container, no separate server to operate. A networked Postgres server (`pg` driver) is the intended path for larger deployments — not yet implemented ([ROADMAP #3](../ROADMAP.md)); PGlite is the only engine today — and must sit behind the same data-access interface, so the engine is swappable without touching call sites.

## The point that settles it

**We integrate with Clio over its API, never its database.** We read `account_tx`/`tx`/`account_info`/etc. and persist our own copy; we never touch Clio's Scylla tables. So matching Clio's backend buys **zero interop benefit**. The decision therefore reduces to "what fits *our* data and *our* queries" — and on that axis Clio and this service are near-opposites.

## Options Considered

#### Option A: ScyllaDB / Cassandra (match Clio)

| Dimension | Assessment |
|-----------|------------|
| Scale fit | Built for the *entire* ledger — 100M+ ledgers, billions of transactions, wide-column lookups by hash/account/sequence. |
| Query fit | No joins; each query pattern needs its own denormalised table, precomputed at write time. |
| Ops | Multi-node cluster, repair, compaction tuning — heavy for a self-hosted single-issuer tool. |
| Consistency | Eventually consistent; multi-row atomicity only via awkward lightweight transactions. |

**Rejected.** Every strength is a strength *at ledger scale*, which is precisely the scale this project filters away.

#### Option B: Postgres *(chosen)*

**Pros:**
- **Scale is inverted.** This is a *filtered* archive: one issuer plus its holders — thousands to low-millions of rows, not billions. That is squarely Postgres territory.
- **Our queries are relational/analytical.** Coverage ranges, membership-vs-completeness as separate claims, balance-at-ledger/time, aggregated deltas over a period, diffing two discovery strategies, reconciliation checkpoints — all want joins, range queries, secondary indexes, and SQL.
- **Correctness wants ACID.** Idempotent ingest keyed on `(hash, address)`, checkpoint-after-each-`marker` resumability, and the fail-closed guarantees elsewhere in this record all lean on transactions and unique constraints.
- **Operability.** Issuers self-host this ahead of a filing deadline. One Postgres (or an embedded PGlite file) is far easier to run, back up, and audit than a Scylla ring. PGlite gives the real dialect in-process, so dev/test and production run the same SQL.

**Cons:** A single Postgres does not scale horizontally the way Scylla does — irrelevant unless the filtered footprint stops being small.

## Consequences

- Storage sits behind a small data-access interface (`query` / `exec` / `transaction`). PGlite backs it now; a networked `pg` implementation can back it later with no change to repositories.
- The reconciler and reporting extensions can be written as ordinary SQL rather than as bespoke precomputed tables.
- **Revisit trigger:** if scope ever grows to many issuances approaching full-ledger volume, this ADR should be reopened — but that would contradict the filtered-archive thesis (ADR-001/007) and is not on the roadmap.
- The `pglite`-for-tests suggestion in `docs/architecture.md` is now the storage engine itself, not just a test fixture.
