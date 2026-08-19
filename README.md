# xrpl-registrar

A filtered XRPL archive registrar: maintains a local, verifiable transaction archive scoped to one or more token issuances (MPT or IOU), sourced from a full-history [Clio](https://xrpl.org/docs/concepts/networks-and-servers/the-clio-server) server, and served through a Clio-compatible API.

**Status: working prototype, verified end-to-end against XRPL testnet.** The full pipeline is implemented and unit-tested — discovery, resumable backfill, live tail, storage, reconciliation, the read API, an authenticated admin API, and a read-only dashboard. Not yet hardened for production (see [Roadmap](#roadmap)).

## Why

Institutional token issuers on the XRP Ledger have recordkeeping obligations that require long-horizon transaction history for a small set of accounts — an issuer and its holders. Running a full-history `xrpld` node is impractical: full history lives in Clio's database, not in the P2P node, and backfilling it over the peer network takes months if it converges at all. Buying history from a provider adds a third-party dependency; querying a public endpoint during a reporting run puts a deadline at the mercy of a shared, rate-limited cluster.

This service holds exactly the history an issuer is required to keep, under the issuer's own control, and nothing else.

Stellar solved the same problem with Horizon's [Ingestion Filtering](https://developers.stellar.org/docs/data/apis/horizon/admin-guide/ingestion-filtering). Neither `xrpld` nor `clio` has an equivalent.

## How it works

Operators configure **issuances**, not account lists. For each issuance the service:

1. **Discovers** the complete set of accounts that ever held the token — via an authorisation scan (auth-required MPTs), a trustline scan (IOUs), or graph traversal (the general fallback), auto-selected from the token's on-ledger flags.
2. **Backfills** each account's history from Clio, bounded and resumable (checkpointed per page, so a crash resumes with no gaps or duplicates), retaining the raw `tx_blob`/`meta_blob` and provenance on every record.
3. **Keeps current** with a live `subscribe` tail (to every holder **and** the issuer) that ingests new transactions, derives their balance deltas as they land, detects ledger-sequence gaps and self-heals them, and **discovers new holders from the stream** — a new holder's first activity routes through the subscribed issuer, so it is picked up live without a periodic full re-scan.
4. **Derives** per-account balance deltas and **reconciles** them against the state reconstructed from metadata.

Reads are served through an API that mirrors Clio's request/response shapes — so existing `xrpl.js` code works by changing a URL — plus namespaced reporting extensions Clio has no equivalent for. All upstream traffic passes through one governed client with a global concurrency cap and honest backoff, so adding issuances never multiplies upstream load.

### Design principles

Data from this archive backs regulatory filings, so the design **fails closed**: empty configuration is an error, out-of-scope requests return a distinct `notInArchive` (never `actNotFound` or a plausible empty result), coverage is reported honestly (never a `-1` echo), and everything derived is re-derivable from the retained raw blobs.

## Quick start

Requires Node 22+, [pnpm](https://pnpm.io/), and a full-history Clio endpoint. Storage is an in-process Postgres ([PGlite](https://pglite.dev/)) — no separate database server or container.

```bash
pnpm install
CLIO_ENDPOINT=wss://<full-history-clio> ADMIN_TOKEN=secret pnpm serve
```

This starts:

- **Public read API** — `ws://127.0.0.1:51234` (WebSocket) and `http://127.0.0.1:51234` (HTTP JSON-RPC).
- **Admin API** — `http://127.0.0.1:51235` (authenticated; only when `ADMIN_TOKEN` is set).
- **Operator dashboard** — `http://127.0.0.1:51235/` (read-only).

Point an `xrpl.js` client at the WebSocket URL, or use `curl`/Postman against the HTTP endpoint exactly as you would a Clio server.

There is also a self-contained tour that discovers + backfills a testnet issuance and queries it back:

```bash
CLIO_ENDPOINT=wss://<testnet-clio> pnpm demo   # override issuance with MPT_ISSUANCE_ID=<hex>
```

## Registering issuances (Admin API)

The unit of configuration is the **issuance**, not an account list. An operator registers an issuance and the registrar derives and maintains the account set itself: on registration it sweeps the issuer's history — discovering every holder and backfilling their transactions in one pass — then captures ledger close times and derives balances, all in the background.

The Admin API runs on a **separate, authenticated port** (`ADMIN_PORT`, default 51235), enabled by setting `ADMIN_TOKEN`. API clients (curl, Postman, xrpl.js) authenticate with `Authorization: Bearer <token>` on every request. The browser dashboard instead signs in once via `POST /admin/login`, which exchanges the token for an httpOnly, `SameSite=Strict` session cookie — so the token is never kept in JS-readable storage. Never expose this port publicly — it surfaces account addresses and archive scope.

The token is a shared secret you choose — there is no registration step and no default. Generate a high-entropy value (at least 256 bits) with a CSPRNG rather than inventing one by hand; any of these work:

```bash
openssl rand -hex 32          # 64 hex chars
# or
head -c 32 /dev/urandom | base64
```

Treat it like a password: store it only in the environment (`ADMIN_TOKEN`, or the `0600` service env file — never commit it), rotate it by setting a new value and restarting, and use a distinct token per deployment. Changing `ADMIN_TOKEN` immediately invalidates existing bearer requests and dashboard sessions.

```bash
# Register an MPT issuance
curl -s http://127.0.0.1:51235/admin/issuances \
  -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"kind":"mpt","mptIssuanceId":"<48-hex MPTokenIssuanceID>"}'

# Register an IOU issuance
curl -s http://127.0.0.1:51235/admin/issuances \
  -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"kind":"iou","currency":"USD","issuer":"rEXAMPLE..."}'
```

`backfillFromLedger` is an optional field that lower-bounds the issuer sweep. (The ingest path is a single issuer `account_tx` sweep that discovers holders and backfills history in one pass, so there is no per-issuance discovery strategy to configure.)

For an IOU, `currency` takes the readable code — a 3-character code (`USD`) or a longer one (`RLUSD`). The 40-hex on-wire form is also accepted and normalised to the readable code, so `RLUSD` and `524C555344…` register identically; a malformed or reserved (`XRP`) code is rejected. Query the reporting extensions with the same readable code.

```
GET   /admin/issuances            # list configured issuances
GET   /admin/issuances/{id}       # status: accounts, backfill progress, coverage, last reconciliation
PATCH /admin/issuances/{id}       # {"enabled": false} to pause
```

The account set is **append-only**: accounts that ever held the token are never pruned, so an exited holder's history is retained. Registration is Admin-API-only by design; the operator dashboard (served at the admin port root) is read-only.

## Querying the archive (read API)

`api_version: 2` is required (requests that omit it are rejected). Methods fall into four classes:

| Class                | Methods                                                            | Behaviour                                                                                                                                                                   |
| -------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Archive-scoped reads | `account_tx`, `tx`, `account_info`, `account_lines`, `mpt_holders` | Served from the archive, scope-checked. Out-of-scope → `notInArchive`; honest coverage ranges.                                                                              |
| Reporting extensions | `archive_balance_at`, `archive_transactions`                       | Namespaced (not Clio-shaped). Point-in-time balances and the itemised per-transaction balance changes — by account, ledger range, **or** date range, exact for MPT and IOU. |
| Node state           | `server_info`, `fee`, `ledger`                                     | Forwarded to a configured upstream.                                                                                                                                         |
| Submission           | `submit`, `submit_multisigned`                                     | Forwarded.                                                                                                                                                                  |

Every archive response carries Clio's `2001` warning plus a filtered-archive warning (id `65001`) flagging that absence may mean out-of-scope rather than non-existent. The warning is a compact marker — the full tracked scope is returned only where it is actionable, in the `notInArchive` error for an out-of-scope request.

```bash
# Current holders of an MPT (HTTP JSON-RPC, like a Clio server)
curl -s http://127.0.0.1:51234 -H 'content-type: application/json' \
  -d '{"method":"mpt_holders","params":[{"mpt_issuance_id":"<hex>","api_version":2}]}'

# A holder's balance as of a date (reporting extension)
curl -s http://127.0.0.1:51234 -H 'content-type: application/json' \
  -d '{"method":"archive_balance_at","params":[{"mpt_issuance_id":"<hex>","account":"r...","date":"2026-03-01T00:00:00Z","api_version":2}]}'
```

Both reporting methods work for MPT **and** IOU issuances. Identify the issuance in any of three ways: by `mpt_issuance_id`, by `currency` + `issuer` (IOU), or by the archive's local `issuance_id` (the numeric id shown by the admin API/dashboard — the same request shape for either kind). `issuance_id` is instance-local and not portable across archive instances, so prefer the ledger-native identifiers for anything that must be reproducible.

```bash
# Same query by currency + issuer (IOU) …
curl -s http://127.0.0.1:51234 -H 'content-type: application/json' \
  -d '{"method":"archive_balance_at","params":[{"currency":"RLUSD","issuer":"r...","account":"r...","ledger_index":20000000,"api_version":2}]}'
# … or by the local issuance id (uniform across kinds)
curl -s http://127.0.0.1:51234 -H 'content-type: application/json' \
  -d '{"method":"archive_balance_at","params":[{"issuance_id":1,"account":"r...","ledger_index":20000000,"api_version":2}]}'
```

`archive_balance_at` accepts `ledger_index` or `date`. `archive_transactions` returns one entry per (transaction, account) — `account`, signed `delta`, `ledger`, `hash`, oldest first — and is filterable by `account`, by ledger range (`from_ledger`/`to_ledger`), and by date range (`from_time`/`to_time`), each optional and combinable; with no range it returns all history. Any ledger field also accepts `"validated"` (the archive's latest ledger).

A [Postman collection](postman/) covering the Admin API and the `archive_*` reporting extensions ships under [`postman/`](postman/README.md) — import it, set `adminToken` and an issuance, and register/query the archive from Postman as you would a Clio server.

## Configuration

All configuration is read from the environment. Copy [`.env.example`](.env.example) to `.env` and adjust. The `pnpm demo` and `pnpm serve` scripts auto-load `.env` (via Node's `--env-file-if-exists`); an inline variable still overrides the file.

| Variable                     | Required | Default       | Notes                                                                                                                                                                                                                                                                                                 |
| ---------------------------- | -------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLIO_ENDPOINT`              | **yes**  | —             | WebSocket URL of a **full-history** Clio server. No default: a missing or wrong source is an error, never a silent fallback.                                                                                                                                                                          |
| `CLIO_HTTP_ENDPOINT`         | no       | _(WebSocket)_ | Optional Clio HTTP JSON-RPC endpoint. When set, the heavy paged `account_tx` backfill/heal uses it — a connection pool parallelises far better than the single WebSocket socket ([ADR-016](docs/adr/adr-016-http-transport-for-backfill-paging.md)). The tail and forwarding stay on `CLIO_ENDPOINT`. |
| `CLIO_MAX_RETRIES`           | no       | `5`           | Retries per request on upstream load signals.                                                                                                                                                                                                                                                         |
| `CLIO_CONNECTION_TIMEOUT_MS` | no       | `20000`       | WebSocket connection timeout.                                                                                                                                                                                                                                                                         |
| `CLIO_REQUEST_TIMEOUT_MS`    | no       | `30000`       | Per-request timeout. Generous by design: a heavy `account_tx` page can take several seconds.                                                                                                                                                                                                          |
| `DATABASE_DIR`               | no       | _(in-memory)_ | Filesystem directory for the in-process (PGlite) database. Unset means an ephemeral in-memory DB (data lost on exit); a persistent archive must set this.                                                                                                                                             |
| `ADMIN_TOKEN`                | no       | —             | Bearer token for the admin API + dashboard on a separate port. Unset disables the admin port. Never expose it publicly.                                                                                                                                                                               |
| `ADMIN_PORT`                 | no       | `51235`       | Port for the authenticated admin API (always bound to loopback).                                                                                                                                                                                                                                      |
| `EXPLORER_BASE_URL`          | no       | —             | Block-explorer base URL. When set, the dashboard links transaction hashes, ledgers, MPT ids, and IOU tokens to it (e.g. `https://livenet.xrpl.org`).                                                                                                                                                  |
| `PORT`                       | no       | `51234`       | Port for the public read API.                                                                                                                                                                                                                                                                         |
| `HOST`                       | no       | `127.0.0.1`   | Bind address for the public read API. Loopback by default — front it with a TLS reverse proxy (see [Deploying](#deploying-on-ubuntu)). Set `0.0.0.0` to expose it directly, only behind a firewall.                                                                                                   |
| `REDISCOVERY_INTERVAL_MS`    | no       | `3600000`     | Safety-net full re-scan interval (1 h). New holders are discovered live from the tail (via the issuer subscription), so this only backstops a holder missed during a tail gap. `0` disables.                                                                                                          |
| `GOVERNOR_MAX_CONCURRENT`    | no       | `4`           | Global cap on in-flight upstream requests, shared across all issuances.                                                                                                                                                                                                                               |
| `GOVERNOR_MIN_BACKOFF_MS`    | no       | `1000`        | First backoff step when upstream sheds load.                                                                                                                                                                                                                                                          |
| `GOVERNOR_MAX_BACKOFF_MS`    | no       | `60000`       | Backoff ceiling.                                                                                                                                                                                                                                                                                      |
| `GOVERNOR_BACKOFF_FACTOR`    | no       | `2`           | Exponential growth between consecutive load signals.                                                                                                                                                                                                                                                  |

## Deploying on Ubuntu

For a persistent, self-hosted install, run the archive as a systemd service. The compiled entrypoint (`pnpm build` → `dist/server.js`, started with `pnpm start`) runs on plain `node` — no `tsx` or transpile step in the runtime path.

```bash
git clone https://github.com/nsmithau/xrpl-registrar.git
cd xrpl-registrar
sudo ./deploy/install.sh          # copies to /opt, builds, installs the unit
sudo nano /etc/xrpl-registrar/xrpl-registrar.env   # set CLIO_ENDPOINT + ADMIN_TOKEN
sudo systemctl start xrpl-registrar
```

The installer is idempotent (re-run it to upgrade), builds under a dedicated `xrpl-registrar` system user, stores data in `/var/lib/xrpl-registrar`, and installs a hardened systemd unit. The read API stays on loopback by default; front it with the supplied nginx + TLS example, and reach the admin dashboard over an SSH tunnel. Full walkthrough — prerequisites, TLS, firewall, backups, upgrades, uninstall — in **[`deploy/README.md`](deploy/README.md)**.

## Development

```bash
pnpm test              # unit tests (offline, in-process Postgres)
pnpm test:integration  # live smoke test — set CLIO_ENDPOINT
pnpm typecheck
pnpm lint
pnpm build             # emit to dist/
```

## Roadmap

Backfill is a single `account_tx` sweep on the **issuer**: because every in-scope transaction — including holder-to-holder transfers — appears in the issuer's `account_tx`, one paginated, resumable sweep discovers every holder and backfills their history at once, so a token with many holders (or several issuances sharing an issuer) costs one sweep, not one per holder. It runs through the single global governor so upstream load stays under the cap. (The tail backfills a _newly_-discovered holder with a per-holder sweep — rare and idempotent.) The live tail keeps everything current incrementally — deriving balance deltas as transactions land and discovering new holders from the stream (via the issuer subscription), so reporting stays accurate without a periodic full re-derivation or re-scan (`REDISCOVERY_INTERVAL_MS` is now a safety-net backstop). The operator dashboard shows live backfill/discovery activity indicators next to the ledger counter. A native Ubuntu deployment path ships in [`deploy/`](deploy/) — a compiled `node` entrypoint, an idempotent installer, a hardened systemd unit, an nginx + TLS example, and a runbook. Not yet built: multi-_process_ backfill (which needs a networked Postgres and a Postgres-coordinated governor rather than the in-process one), a durable ingest trigger, periodic external reconciliation against upstream, and the remaining ops surface (a metrics endpoint, a container image). The public read API binds to localhost by default and the admin surface must never be publicly exposed.

## Licence

Apache-2.0.
