# ADR-004: Mirror the Clio API, `api_version 2` only

**Date:** 2026-08-12

## Context

The archive needs a read interface. The obvious choice is a bespoke REST or SQL surface designed around reporting.

## Decision

Mirror Clio's request and response shapes for a supported method set, at `api_version 2` only. Add reporting capabilities as separate, clearly namespaced extension methods rather than bending Clio-shaped methods to fit.

## Options Considered

#### Option A: Bespoke REST/SQL API

**Pros:** Designed around the actual use case. No compatibility burden.
**Cons:** Every consumer writes new client code, which directly undercuts the external-adoption objective.

#### Option B: Mirror Clio _(chosen)_

**Pros:** Existing xrpl.js code works by changing a URL. Yields a free correctness harness — the same request can be run against the registrar and upstream Clio and the responses diffed. Makes upstream pass-through natural, since the protocol is identical.
**Cons:** Inherits Clio's quirks. Requires deciding deliberately where to deviate.

## Version choice

`api_version` 1 and 2 have materially different response shapes (`tx` vs `tx_json`, among others). Defaults vary by client — a direct JSON-RPC/WebSocket connection defaults to **1**, xrpl.js 4.x+ and xrpl-py 3.x+ default to **2**. Supporting both means two serialisers and a doubled equivalence suite. We support v2 only.

## Consequences

- **Requests omitting `api_version` must be rejected explicitly**, because the protocol default is v1 and silently serving v2 shapes would be exactly the plausible-wrong-answer failure this project is trying to avoid.
- `server_info` **must** include `network_id` — xrpl.js v5 throws on a missing value and will not connect without it.
- API equivalence against upstream Clio becomes a testable success metric.
- Clio's forwarding behaviour is inherited: requests carrying `ledger_index: current` forward to a P2P node and return `forwarded: true`. Verified that this happens **regardless of whether the target method accepts the parameter** — `server_info` with `ledger_index: "50000"` is answered locally, but with `"current"` it is proxied. The forwarding layer sits in front of the method handlers.
