# xrpl-ingestor

A filtered XRPL archive ingestor: maintains a local, verifiable transaction archive scoped to one or more token issuances (MPT or IOU), sourced from a full-history [Clio](https://xrpl.org/docs/concepts/networks-and-servers/the-clio-server) server, and served through a Clio-compatible API.

**Status: early implementation.** The Clio client and its global concurrency governor — the single upstream chokepoint every other component builds on — are implemented and unit-tested. Discovery, backfill, live tail, reconciler, forwarder, storage, and the API surface are not yet built.

## Why

Institutional token issuers on the XRP Ledger have recordkeeping obligations that require long-horizon transaction history for a small set of accounts — an issuer and its holders. Running a full-history `xrpld` node is impractical: full history lives in Clio's database, not in the P2P node, and backfilling it over the peer network takes months if it converges at all. Buying history from a provider adds a third-party dependency; querying a public endpoint during a reporting run puts a deadline at the mercy of a shared, rate-limited cluster.

This service holds exactly the history an issuer is required to keep, under the issuer's own control, and nothing else.

Stellar solved the same problem with Horizon's [Ingestion Filtering](https://developers.stellar.org/docs/data/apis/horizon/admin-guide/ingestion-filtering). Neither `xrpld` nor `clio` has an equivalent.

## How it works

Operators configure **issuances**, not account lists. For each issuance the service derives the complete set of accounts that ever held the token, backfills their history from Clio, and keeps it current with a live tail. Reads are served through an API that mirrors Clio's request and response shapes, so existing `xrpl.js` code works by changing a URL.

## Development

Requires Node 22+ and [pnpm](https://pnpm.io/).

```bash
pnpm install
pnpm test        # vitest
pnpm typecheck   # tsc --noEmit
pnpm lint        # eslint
pnpm build       # emit to dist/
```

### Configuration

All configuration is read from the environment. Copy [`.env.example`](.env.example) to `.env` and adjust:

```bash
cp .env.example .env
```

The `pnpm demo` and `pnpm serve` scripts auto-load `.env` (via Node's `--env-file-if-exists`), so you can run them with no inline variables. An inline variable still overrides the file — e.g. `CLIO_ENDPOINT=… pnpm serve`.

| Variable | Required | Default | Notes |
|----------|----------|---------|-------|
| `CLIO_ENDPOINT` | **yes** | — | WebSocket URL of a **full-history** Clio server. No default: a missing or wrong source is an error, never a silent fallback. |
| `CLIO_MAX_RETRIES` | no | `5` | Retries per request on upstream load signals. |
| `CLIO_CONNECTION_TIMEOUT_MS` | no | `20000` | WebSocket connection timeout. |
| `DATABASE_DIR` | no | *(in-memory)* | Filesystem directory for the in-process (PGlite) database. Unset means an ephemeral in-memory DB (data lost on exit); a persistent archive must set this. |
| `GOVERNOR_MAX_CONCURRENT` | no | `4` | Global cap on in-flight upstream requests, shared across all issuances. |
| `GOVERNOR_MIN_BACKOFF_MS` | no | `1000` | First backoff step when upstream sheds load. |
| `GOVERNOR_MAX_BACKOFF_MS` | no | `60000` | Backoff ceiling. |
| `GOVERNOR_BACKOFF_FACTOR` | no | `2` | Exponential growth between consecutive load signals. |

Concurrency and backoff are governed **globally**, not per issuance — adding issuances does not multiply upstream load. Storage is an in-process Postgres ([PGlite](https://pglite.dev/)) — no separate database server or container to run.

### End-to-end demo

[`examples/mpt-demo.ts`](examples/mpt-demo.ts) registers an MPT issuance, discovers its holders from a live Clio, backfills their transactions into an in-process database with provenance, and queries the archive back — a compact tour of the governed client + storage together. Point it at any full-history **testnet** Clio (the endpoint is taken from the environment, so no host is baked into the source):

```bash
CLIO_ENDPOINT=wss://<testnet-clio-endpoint> pnpm demo
```

It uses an example testnet issuance by default; override with `MPT_ISSUANCE_ID=<hex>`. Note the testnet is periodically reset, so a testnet Clio is "full history" only since the last reset — enough to see an issuance's whole lifecycle.

## Registering issuances (Admin API)

> **Not yet implemented.** This section documents the target Admin API so the
> intended operator workflow is clear; the endpoints below do not exist yet and
> the shapes may change. Track the implementation status in the project board.

The unit of configuration is the **issuance**, not an account list. An operator registers an issuance and the ingestor derives and maintains the account set itself: it auto-detects the discovery strategy from the token's on-ledger flags, runs discovery, backfills history, then keeps the archive current with a live tail.

The Admin API is served on a **separate, authenticated admin port** — never publicly exposed by default — and is distinct from the public Clio-compatible read API.

**Register an MPT issuance** (e.g. an auth-required MPT):

```http
POST /admin/issuances
Content-Type: application/json

{
  "kind": "mpt",
  "mpt_issuance_id": "<64-hex MPTokenIssuanceID>",
  "backfill_from_ledger": 0,          // optional; default = the issuance's creation ledger
  "discovery_strategy": "auto",       // optional override: auto | authorization | traversal
  "enabled": true
}
```

**Register an IOU issuance:**

```http
POST /admin/issuances
Content-Type: application/json

{
  "kind": "iou",
  "currency": "USD",
  "issuer_account": "rEXAMPLE...",
  "discovery_strategy": "auto",       // optional override: auto | trustline | traversal
  "enabled": true
}
```

On registration the ingestor reads the issuance's flags to pick a strategy (auth-required MPT → authorisation scan; IOU → trustline scan; non-auth MPT → graph traversal), all overridable via `discovery_strategy`.

**Inspect and manage:**

```http
GET   /admin/issuances            # list configured issuances and their progress
GET   /admin/issuances/{id}       # one issuance: strategy, coverage, backfill state
PATCH /admin/issuances/{id}       # { "enabled": false } to pause ingestion
```

The account set is **append-only**: accounts that ever held the token are never pruned, so an exited holder's history is retained. The operator UI is **read-only** — it shows progress and coverage but does not mutate scope; registration is Admin-API-only by design.

## Licence

Apache-2.0.
