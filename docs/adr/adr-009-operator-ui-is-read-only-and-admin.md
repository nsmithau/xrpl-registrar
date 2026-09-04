# ADR-009: Operator UI is read-only and admin-port bound

**Date:** 2026-08-12

## Context

Operators need to see archive contents and backfill progress without reading logs or writing SQL — particularly during the first 13-month backfill, which runs for hours against a shared endpoint.

## Decision

A single-page dashboard served by the service itself, static assets embedded in the artifact, reading the same data as the admin API and the coverage tables. **Read-only in v1**, bound to the admin port, authenticated, never publicly exposed by default.

## Rationale

- **Read-only:** configuration changes stay on the admin API. A UI that can alter the scope of a regulatory archive needs an authorisation and audit-trail design done deliberately, not as a side effect of adding a dashboard.
- **Admin-port bound:** the dashboard surfaces account addresses and archive scope — material information about an issuer's investors. Administrative surfaces belong on a separate port from the public API.
- **Same data source as the admin API:** the dashboard is a view over the admin JSON endpoints, never a parallel implementation — one would drift, and a drifting dashboard is worse than none. (A `/metrics` endpoint is not yet built — [ROADMAP #6](../ROADMAP.md); when it is, it must read the same counters.)

## Consequences

- Deployment docs must state the exposure model plainly rather than leaving operators to infer it.
- Dashboard queries must not contend with ingestion — serve from precomputed counters, not scans.
- Scope is deliberately narrow: no balance browsing, no statement previews, no per-investor drill-down, no user management, no multi-tenancy. Widening it widens the data-exposure question.
- **Auth, as implemented:** the dashboard inherits admin-port protection. It signs in once via `POST /admin/login`, exchanging the same `ADMIN_TOKEN` for an httpOnly, `SameSite=Strict` session cookie (12 h TTL), so the token is never held in JS-readable storage; API clients use the bearer header directly. Still open: a distinct view-only credential for issuers who want operators to see progress without holding the token that also grants configuration rights.
