# ADR-008: TypeScript on Node with `xrpl` v5

**Date:** 2026-08-12

## Context

The registrar is a data-engineering workload — parallel backfill fan-out, sustained bulk Postgres writes, long-running memory stability, and binary blob parsing if ingesting with `binary: true`.

## Decision

TypeScript on Node, using `xrpl` v5.

## Options Considered

| Option | Pros | Cons |
|--------|------|------|
| xrpl.js (chosen) | Most mature XRPLF library; largest XRPL developer pool; documented MPT support; tracks amendments early | Single-threaded runtime; parallelism needs explicit work |
| Go / xrpl-go | Concurrency model fits backfill fan-out; better sustained-throughput ergonomics | Thinnest public evidence of MPT coverage; smallest contributor pool |
| Python / xrpl-py | Mature, good MPT support | Middle ground on both axes; no decisive advantage |

## Trade-off Analysis

The registrar barely uses the client library — it needs WebSocket subscribe, JSON-RPC with `marker` pagination, and the binary codec, all of which every option provides. So this was never an API-coverage decision. It is a contributor-pool versus runtime-ergonomics decision.

Because the project ships as an open-source reference implementation rather than a hosted service, adoption and external contribution *are* the objective. That is the axis xrpl.js wins on decisively.

## Consequences

- **Backfill parallelism across accounts requires explicit worker threads or multiple processes.** This is the main cost of the decision. Design for it up front rather than discovering it under load.
- Memory behaviour under sustained bulk writes needs attention.
- v5 breaking changes are signing/wallet related and irrelevant here — the service is read-only and handles no key material. The exception that *does* affect us: v5 throws on `server_info` failure or missing `network_id`, making that field mandatory in our responses.
- `MPTAmount` serialises as a string as of v5.
- Verified: `xrpl@5.0.0` installs and loads on Node v22.22.3.
