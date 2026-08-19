# ADR-016: Page `account_tx` over HTTP JSON-RPC for backfill; WebSocket only for the tail

**Status:** Accepted — implemented, opt-in via `CLIO_HTTP_ENDPOINT`.

## Context

Backfill and gap-heal page an issuer's `account_tx` (binary, `limit` 200) — the
heaviest and most voluminous upstream traffic the registrar generates. The Clio
client is a single xrpl.js **WebSocket** `Client`; every request multiplexes over
that one socket.

Load-probing (ADR-015) showed heavy `account_tx` does **not** parallelise over a
single socket: per-page latency balloons with concurrency (≈660 ms at C=1 → ~5 s
at C=4 → timeouts at C=16 on mainnet) because the large binary responses
head-of-line-block. Over **HTTP JSON-RPC** the same paging holds a flat
≈195 ms/page regardless of concurrency — a connection pool gives real parallelism
— and scales throughput roughly 5–25×. Backfill wall-clock at scale is dominated
by this paging, so the transport, not the governor, is the real lever.

## Decision

Add an HTTP JSON-RPC path to the Clio client and use it for the **paged
`account_tx` workload** (initial issuer sweep + gap heal). Keep **WebSocket** for
the live `subscribe` tail (which needs a persistent connection) and for
node-state / forwarded calls. Both transports go through the same global
governor.

The storage layer already keeps identical binary blobs regardless of transport,
so there is no data-shape change — this is purely how the bytes are fetched. The
`ClioTransport` interface already abstracts `request()`; the implementation adds
an HTTP-backed transport and routes the paging call sites to it.

**As implemented:** `HttpTransport` (JSON-RPC over `fetch`) sits behind the same
`ClioClient`/governor as the WS transport. `createClioClient` returns a
`pagingClient` — the HTTP client when `CLIO_HTTP_ENDPOINT` is set, else the WS
client as a fallback — and `serve` routes the issuer sweep, gap heal, and
per-holder backfill through it while the tail, forwarding, and low-volume calls
stay on WS. Both clients share one governor, so the global concurrency cap and
backoff hold across transports. `classifyError` now maps HTTP `429`/`5xx` to load
signals; `Retry-After` is captured on the error but not yet honoured by the
governor (no probed endpoint sends it — a future refinement).

## Consequences

- Backfill/heal wall-clock drops substantially at scale (the dominant cost is
  `account_tx` paging).
- Two upstream transports to operate and observe; **both must honour the same
  load signals** — add HTTP `503`/`429` (and any `Retry-After`) to
  `classifyError`, which is WS-only today.
- Per-transport concurrency becomes worthwhile: HTTP parallelises, so its cap can
  be higher than WS's, whereas the WS cap stays low (ADR-015). The governor may
  need a per-transport (or per-path) limit rather than one global number.
- The subscribe tail stays on WS unchanged.

## Options considered

| Option                                           | Verdict                                                                                                                            |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Single WS for everything _(current)_             | Rejected for backfill: heavy `account_tx` serialises on one socket — throughput doesn't scale and pages time out under contention. |
| Pool of WS connections                           | Possible, but heavier to manage (N sockets, reconnect/subscribe semantics) than stateless request/response.                        |
| **HTTP for paging + WS for the tail** _(chosen)_ | Matches each workload to its transport: stateless bulk paging over pooled HTTP, persistent stream over WS.                         |
