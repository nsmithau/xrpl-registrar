# ADR-001: Build a purpose-built registrar rather than forking Stellar Horizon

**Date:** 2026-08-12

## Context

An institutional token issuer needs long-horizon XRPL transaction history for their issuer account and all holders, to meet a regulatory reporting obligation. The same problem is already solved on Stellar using Horizon's **Ingestion Filtering** — an account/asset whitelist applied during ingest, open source under Apache-2.0, cutting storage by over 99% for a narrow account set. Neither `xrpld` nor `clio` has an equivalent. The obvious move is to fork Horizon.

## Decision

Build a purpose-built XRPL registrar. Take the *concept* from Horizon — whitelist applied at ingest, admin API for filter rules, non-retroactive filtering — not the code.

## Options Considered

#### Option A: Fork stellar/stellar-horizon

| Dimension | Assessment |
|-----------|------------|
| Complexity | High — most of the codebase is unusable |
| Cost | High ongoing maintenance of a large foreign codebase |
| Scalability | N/A |
| Team familiarity | Low (Go, Stellar domain model) |

**Pros:** Filtering logic already exists and is battle-tested. Horizon-shaped API might let the issuer reuse existing client code.

**Cons:** Horizon's substance is Stellar-specific — the XDR codec, captive-core and history-archive ingest backends, and a Postgres schema modelled on Stellar's operation/effect/trade taxonomy. None of it maps to XRPL. The reusable part, the filter predicate in the ingest loop plus an admin CRUD endpoint, is the cheapest part to write from scratch. The API-compatibility argument collapses on MPTs specifically: Stellar models holdings as trustlines on a `code:issuer` pair and has no MPT equivalent, so new tables and endpoints are needed anyway, and the issuer rewrites their calculation layer regardless.

#### Option B: Purpose-built registrar over Clio *(chosen)*

**Pros:** Small surface. Native XRPL data model. No foreign codebase to maintain.
**Cons:** Filtering and backfill logic written from scratch; no inherited test coverage.

## Consequences

- We own all the correctness risk in backfill and filtering — hence the emphasis on reconciliation and cross-checked discovery elsewhere in this record.
- Horizon's *documented behaviours* remain a useful reference, particularly the non-retroactive filtering limitation, which we inherit conceptually and must document as prominently as Stellar does.
