# ADR-001: Build a purpose-built registrar rather than adapting an existing filtered indexer

**Date:** 2026-08-12

## Context

An institutional token issuer needs long-horizon XRPL transaction history for their issuer account and all holders, to meet a regulatory reporting obligation. Other ledgers already solve this with **filtered ingestion** in their open-source indexers — an account/asset whitelist applied during ingest, cutting storage by over 99% for a narrow account set. Neither `xrpld` nor `clio` has an equivalent. The obvious move is to fork one of those indexers and point it at XRPL.

## Decision

Build a purpose-built XRPL registrar. Take the *concept* from those indexers — whitelist applied at ingest, admin API for filter rules, non-retroactive filtering — not the code.

## Options Considered

#### Option A: Fork an existing filtered indexer from another ledger

| Dimension | Assessment |
|-----------|------------|
| Complexity | High — most of the codebase is unusable |
| Cost | High ongoing maintenance of a large foreign codebase |
| Scalability | N/A |
| Team familiarity | Low (different language and domain model) |

**Pros:** Filtering logic already exists and is battle-tested. A familiar API shape might let the issuer reuse existing client code.

**Cons:** The substance of such an indexer is specific to its own ledger — the wire codec, the ingest backends, and a database schema modelled on that ledger's operation taxonomy. None of it maps to XRPL. The reusable part, the filter predicate in the ingest loop plus an admin CRUD endpoint, is the cheapest part to write from scratch. The API-compatibility argument collapses on MPTs specifically: other ledgers model holdings as trustlines on a `code:issuer` pair and have no MPT equivalent, so new tables and endpoints are needed anyway, and the issuer rewrites their calculation layer regardless.

#### Option B: Purpose-built registrar over Clio *(chosen)*

**Pros:** Small surface. Native XRPL data model. No foreign codebase to maintain.
**Cons:** Filtering and backfill logic written from scratch; no inherited test coverage.

## Consequences

- We own all the correctness risk in backfill and filtering — hence the emphasis on reconciliation and cross-checked discovery elsewhere in this record.
- The *documented behaviours* of prior filtered indexers remain a useful reference, particularly the non-retroactive filtering limitation, which we inherit conceptually and must document just as prominently.
