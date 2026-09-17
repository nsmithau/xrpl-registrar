# ADR-010: Store the filtered archive in Postgres, not Clio's Scylla/Cassandra backend

**Date:** 2026-08-12

## Context

Clio stores the full XRPL history in ScyllaDB (Cassandra-compatible). Since we source everything from Clio, the natural question is whether to match its backend — reuse Clio's proven data model, share operational know-how, keep the door open to feeding a Clio instance directly.

`docs/architecture.md` already assumes Postgres, but the choice was never defended against Scylla in a decision record. This ADR does that, because "the source of truth uses Scylla" is a reasonable-sounding reason to reach for it, and the reasons not to are invisible from the call site.

## Decision

Store the archive in **Postgres**. For development, test, and small single-issuer deployments, run it **in-process via [PGlite](https://pglite.dev/)** — a real Postgres (WASM) with the genuine SQL dialect, no container, no separate server to operate. A networked Postgres server (`pg` driver) is available for larger deployments, selected with `DATABASE_URL`. Both sit behind the same data-access interface, so the engine is swappable without touching call sites.

**Update (2026-09-17):** the networked `pg` engine is now implemented (`src/db/postgres.ts`). PGlite remains the default — a self-hosting issuer should not need a database server to stand up — and the two are never both configured: setting `DATABASE_URL` and `DATABASE_DIR` together is an error rather than a precedence rule, because they are different archives and silently choosing one would read as data loss. No schema or repository SQL changed. See [Consequences](#consequences) for the one thing that did.

## The point that settles it

**We integrate with Clio over its API, never its database.** We read `account_tx`/`tx`/`account_info`/etc. and persist our own copy; we never touch Clio's Scylla tables. So matching Clio's backend buys **zero interop benefit**. The decision therefore reduces to "what fits _our_ data and _our_ queries" — and on that axis Clio and this service are near-opposites.

## Options Considered

#### Option A: ScyllaDB / Cassandra (match Clio)

| Dimension   | Assessment                                                                                                             |
| ----------- | ---------------------------------------------------------------------------------------------------------------------- |
| Scale fit   | Built for the _entire_ ledger — 100M+ ledgers, billions of transactions, wide-column lookups by hash/account/sequence. |
| Query fit   | No joins; each query pattern needs its own denormalised table, precomputed at write time.                              |
| Ops         | Multi-node cluster, repair, compaction tuning — heavy for a self-hosted single-issuer tool.                            |
| Consistency | Eventually consistent; multi-row atomicity only via awkward lightweight transactions.                                  |

**Rejected.** Every strength is a strength _at ledger scale_, which is precisely the scale this project filters away.

#### Option B: Postgres _(chosen)_

**Pros:**

- **Scale is inverted.** This is a _filtered_ archive: one issuer plus its holders — thousands to low-millions of rows, not billions. That is squarely Postgres territory.
- **Our queries are relational/analytical.** Coverage ranges, membership-vs-completeness as separate claims, balance-at-ledger/time, aggregated deltas over a period, diffing two discovery strategies, reconciliation checkpoints — all want joins, range queries, secondary indexes, and SQL.
- **Correctness wants ACID.** Idempotent ingest keyed on `(hash, address)`, checkpoint-after-each-`marker` resumability, and the fail-closed guarantees elsewhere in this record all lean on transactions and unique constraints.
- **Operability.** Issuers self-host this ahead of a filing deadline. One Postgres (or an embedded PGlite file) is far easier to run, back up, and audit than a Scylla ring. PGlite gives the real dialect in-process, so dev/test and production run the same SQL.

**Cons:** A single Postgres does not scale horizontally the way Scylla does — irrelevant unless the filtered footprint stops being small.

## Consequences

- Storage sits behind a small data-access interface (`query` / `exec` / `transaction`). Both PGlite and networked `pg` back it, with no change to repositories.

- **Swapping the engine changes concurrency, and nothing else.** This is the one consequence that is invisible from the call site and the reason several pieces of code exist that otherwise look like overkill. PGlite serialises every statement on a single thread, so the backfill worker's four concurrent account loops and the gap heal's four concurrent issuer sweeps interleave but never truly contend. On a connection pool they become genuinely concurrent transactions upserting overlapping rows in `accounts`, `transactions`, and `balance_deltas` — so deadlocks are an expected operating condition, not a defect. Three things follow, and none should be removed as redundant:

  - The batch writers (`insertTransactionRowsMany`, `insertDeltasMany`) sort rows by primary key, so concurrent transactions take row locks in a consistent order. Measured: without it, two transactions touching the same rows in opposite orders deadlock reliably; with it, they serialise instead.
  - `PostgresDatabase.transaction` retries on `40P01`/`40001`. **This relies on `fn` being idempotent** — true today because every write is keyed and conflict-handled (`ON CONFLICT DO NOTHING` / `DO UPDATE`), the same property that makes backfill resumable after a mid-page kill. A future caller doing something unconditional here would double-apply it under contention.
  - Schema migration takes a session-level advisory lock, keyed on `(constant, schema)`. Two processes starting at once is an ordinary restart, but `runMigrations` reads the applied set and then acts on it, which is not atomic. Measured: five simultaneous unlocked migrators against an empty schema left four of them failing on catalog-level unique violations. The key includes the schema because two archives in different schemas of one database share no tables and should not block each other.

- Because a contention bug cannot appear on PGlite at all, the test suite runs against **both** engines: `pnpm test` on PGlite and `pnpm test:pg` on a real server, the latter adding suites for concurrency, driver type mapping, and the migration lock. Each "does not deadlock" test is paired with a control that does — a concurrency test that never contends passes for the wrong reason.
- The reconciler and reporting extensions can be written as ordinary SQL rather than as bespoke precomputed tables.
- **Revisit trigger:** if scope ever grows to many issuances approaching full-ledger volume, this ADR should be reopened — but that would contradict the filtered-archive thesis (ADR-001/007) and is not on the roadmap.
- The `pglite`-for-tests suggestion in `docs/architecture.md` is now the storage engine itself, not just a test fixture.
