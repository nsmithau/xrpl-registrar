# ADR-009: Operator UI is read-only and admin-port bound

**Date:** 2026-08-12

## Context

Operators need to see archive contents and backfill progress without reading logs or writing SQL — particularly during the first 13-month backfill, which runs for hours against a shared endpoint.

## Decision

A single-page dashboard served by the service itself, static assets embedded in the artifact, reading the same data as `/metrics` and the coverage tables. **Read-only in v1**, bound to the admin port, authenticated, never publicly exposed by default.

## Rationale

- **Read-only:** configuration changes stay on the admin API. A UI that can alter the scope of a regulatory archive needs an authorisation and audit-trail design done deliberately, not as a side effect of adding a dashboard.
- **Admin-port bound:** the dashboard surfaces account addresses and archive scope — material information about an issuer's investors. Follows Horizon's precedent of putting administrative surfaces on a separate port.
- **Same data source as `/metrics`:** a parallel implementation would drift, and a drifting dashboard is worse than none.

## Consequences

- Deployment docs must state the exposure model plainly rather than leaving operators to infer it.
- Dashboard queries must not contend with ingestion — serve from precomputed counters, not scans.
- Scope is deliberately narrow: no balance browsing, no statement previews, no per-investor drill-down, no user management, no multi-tenancy. Widening it widens the data-exposure question.
- Open question: whether UI auth inherits admin-port protection or needs a distinct login. Inheriting is simplest but may be too coarse for issuers who want operators to see progress without granting configuration rights.
