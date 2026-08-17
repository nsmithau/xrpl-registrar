# Architecture Decision Records

Architecture decisions taken during design, August 2026. Each records the options considered and why the rejected ones were rejected.

**Read this before revisiting a design choice.** Several of these look like obvious simplifications from inside the code. They were considered and rejected for reasons that are invisible at the call site. Disagreeing is legitimate — superseding an ADR explicitly is the way to do it.

Deciders throughout: Neil Smith. Status of all: **Accepted** unless noted.

---

| ADR | Decision |
|-----|----------|
| [ADR-001](adr-001-build-a-purpose-built-ingestor-rather-than.md) | Build a purpose-built ingestor rather than forking Stellar Horizon |
| [ADR-002](adr-002-source-all-history-from-clio-never-from.md) | Source all history from Clio, never from `xrpld` |
| [ADR-003](adr-003-public-clio-cluster-for-alpha-beta.md) | Use a public Clio cluster for Alpha and Beta |
| [ADR-004](adr-004-mirror-the-clio-api-api-version-2.md) | Mirror the Clio API, `api_version 2` only |
| [ADR-005](adr-005-out-of-scope-requests-fail-closed.md) | Out-of-scope requests fail closed |
| [ADR-006](adr-006-keep-warning-id-2001-add-a-separate.md) | Keep warning id 2001; add a separate id for filtered-archive status |
| [ADR-007](adr-007-traversal-is-the-general-discovery-algorithm-issuer.md) | Traversal is the general discovery algorithm; issuer-scoped queries are optimisations |
| [ADR-008](adr-008-typescript-on-node-with-xrpl-v5.md) | TypeScript on Node with `xrpl` v5 |
| [ADR-009](adr-009-operator-ui-is-read-only-and-admin.md) | Operator UI is read-only and admin-port bound |
| [ADR-010](adr-010-store-the-filtered-archive-in-postgres-not.md) | Store the filtered archive in Postgres, not Clio's Scylla/Cassandra backend |
| [ADR-011](adr-011-license-under-apache-2-0.md) | License under Apache-2.0 |
| [ADR-012](adr-012-tail-driven-incremental-maintenance-not-periodic-full.md) | Tail-driven incremental maintenance, not periodic full re-derivation/re-scan |
| [ADR-013](adr-013-issuer-centric-backfill-one-account-tx-sweep.md) | Issuer-centric backfill — one `account_tx` sweep per issuer, not per holder |
| [ADR-014](adr-014-resolve-ledger-close-times-lazily-not-eagerly.md) | Resolve ledger close times lazily, not eagerly at ingest |

