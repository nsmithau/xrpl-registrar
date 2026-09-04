# ADR-015: Concurrency governor settings, tuned by load-probing public Clio

## Context

The global concurrency governor caps in-flight upstream requests and backs off on
load signals, but its defaults were set conservatively without measurement. A
standalone probe (`examples/probe-ratelimit.ts`; plan in the internal
`docs/perf/rate-limit-probe-plan.md`, not published) load-tested the public **testnet** and
**mainnet** full-history Clio clusters over both WebSocket and HTTP JSON-RPC,
bucketing every failure by the same `classifyError` signals the governor reacts
to. This ADR records what it found and the settings that follow.

## Findings

- **Light requests (`server_info`) are rate-shaped over WS.** Clean to ~20 req/s
  (testnet) / ~38 req/s (mainnet), then `slowDown`; the concurrency ramp and the
  rate ramp break at the same *offered rate*, so the limit is req/s, not in-flight
  count. HTTP JSON-RPC has far more headroom (~150 req/s on mainnet), shedding via
  HTTP `503`.
- **Heavy requests (paged binary `account_tx` — the backfill workload) are
  latency-bound over WS and do not parallelise on one socket.** Throughput is
  *highest at concurrency 1* (~1.5/s, ~660 ms/page on mainnet) and *degrades* as
  concurrency rises (≈5 s/page at C=4, timeouts at C=16), because the large binary
  responses head-of-line-block on the single WebSocket. Over HTTP the same paging
  holds ≈195 ms/page flat regardless of concurrency. This transport consequence is
  ADR-016.
- **Recovery after a shed is fast:** 2.5 s (HTTP light) → ~3.5 s (WS light) →
  ~6 s (HTTP heavy) → ~10.6 s (WS heavy). No `Retry-After` is ever sent (WS
  `slowDown` and HTTP `503` both arrive bare).

## Decision (validated defaults)

- **`maxConcurrent = 4`.** Under the light-WS knee on both endpoints (testnet
  ~C=4–8, mainnet ~C=8), and the heavy-WS path *wants* low concurrency
  (serialisation), so 4 is the right conservative global value. **Do not raise
  it** — higher concurrency inflates heavy-page latency without adding throughput
  on a single socket.
- **Per-request timeout = 30 s (`CLIO_REQUEST_TIMEOUT_MS`).** Heavy pages reach
  5–10 s under contention; a short timeout would spuriously fail slow-but-valid
  pages and drive needless backoff. (Previously only `connectionTimeout` was set,
  leaving requests on the xrpl.js ~10 s default.)
- **Backoff `min 1 s × 2 up to 60 s`, `maxRetries 5`.** The escalation reaches the
  observed 2.5–10.6 s recovery within a few penalties.
- **No token-bucket rate limiter.** The dominant (heavy) load is latency/socket-
  bound, which `maxConcurrent` governs; light methods tolerate high rates.
  Revisit only if a cheap, high-rate call path appears.

## Consequences

- Governor defaults are now evidence-based, with per-endpoint knees documented.
- The heavy-path serialisation finding motivates **ADR-016** (HTTP for backfill
  paging), which is the real backfill-throughput lever — not the governor.
- The probe is repeatable (`pnpm probe`) to re-tune against a replacement upstream
  (ADR-003) before any real filing.
