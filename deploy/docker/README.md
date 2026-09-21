# Running xrpl-registrar in Docker

A Postgres-only container image plus a compose stack that runs it alongside
`postgres:17`. The image pins `STORAGE_ENGINE=postgres`: a container's
filesystem is ephemeral, so a registrar that silently fell back to the
in-process PGlite engine would be an archive that evaporates on restart — it
refuses to start without `DATABASE_URL` instead
([ADR-019](../../docs/adr/adr-019-container-image-and-lan-exposure.md)).

Contents:

- [Prerequisites](#prerequisites)
- [1. Configure](#1-configure)
- [2. Start and verify](#2-start-and-verify)
- [3. Exposure: loopback by default, LAN behind your proxy](#3-exposure-loopback-by-default-lan-behind-your-proxy)
- [4. Using an existing Postgres](#4-using-an-existing-postgres)
- [Upgrades](#upgrades)
- [Backups](#backups)
- [Teardown](#teardown)
- [Troubleshooting](#troubleshooting)

## Prerequisites

Docker Engine with the `docker compose` plugin (or the standalone
`docker-compose` binary — same commands, with a hyphen). Any Docker-compatible
runtime works; under [colima](https://github.com/abiosoft/colima) you may need
to point the CLI at its socket first:

```bash
export DOCKER_HOST="unix://$HOME/.colima/default/docker.sock"
```

The Dockerfile uses no BuildKit-only features, so a plain `docker build`
(no buildx plugin) is enough.

## 1. Configure

```bash
cp deploy/docker/.env.example deploy/docker/.env
```

Edit `deploy/docker/.env` and set:

- **`CLIO_ENDPOINT`** — WebSocket URL of a **full-history** Clio server. Required.
- **`CLIO_HTTP_ENDPOINT`** _(recommended)_ — HTTP JSON-RPC endpoint for heavy
  backfill paging ([ADR-016](../../docs/adr/adr-016-http-transport-for-backfill-paging.md)).
- **`POSTGRES_PASSWORD`** — for the bundled Postgres; also composed into the
  registrar's `DATABASE_URL`.
- **`ADMIN_TOKEN`** — `openssl rand -hex 32`. Without it the admin port is
  disabled and nothing can be registered.

Compose reads this one file twice: for the `${…}` substitutions in
`compose.yml` (`POSTGRES_PASSWORD`, `BIND_ADDRESS`, the published ports) and as
the registrar container's environment. Keep the repo-root `.env` for
`pnpm serve` — it selects the in-process engine, which the image refuses. Do not
set `HOST`, `ADMIN_HOST`, `PORT`, `ADMIN_PORT`, `STORAGE_ENGINE`, `DATABASE_URL`
or `DATABASE_DIR` here: the image and `compose.yml` own those.

## 2. Start and verify

```bash
docker compose -f deploy/docker/compose.yml up -d --build --wait
curl -s http://127.0.0.1:51234/healthz
# {"engine":"postgres","latest_ledger":null,"status":"ok"}
docker compose -f deploy/docker/compose.yml logs -f registrar
```

A healthy startup logs the Clio version, complete-ledger range and
`network_id`, then `Archive serving`. Open the dashboard at
<http://127.0.0.1:51235/> and paste your `ADMIN_TOKEN`, or register an
issuance from the shell:

```bash
curl -s -X POST http://127.0.0.1:51235/admin/issuances \
  -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"kind":"mpt","mptIssuanceId":"<48-hex MPTokenIssuanceID>"}'
```

`GET /healthz` is what the image's `HEALTHCHECK` and your proxy's probe should
use. It reports 200 while the process is up and the database answers; it does
**not** depend on the upstream Clio link, so an upstream outage does not restart
the container mid-sweep (the archive keeps serving local data regardless).

Migrations run automatically at startup, serialised by an advisory lock. Run
**one registrar replica** per database: the upstream concurrency governor is
in-process, so two replicas would double the load on Clio (ROADMAP #3).

## 3. Exposure: loopback by default, LAN behind your proxy

Inside the container both listeners bind `0.0.0.0` (Docker's bridge network
cannot reach a loopback bind). What the outside sees is decided by the **host
port mapping**, and by default both ports are published on the host's loopback
only — the same posture as the systemd deployment, reachable over an SSH tunnel.

To open them to a LAN, set in `deploy/docker/.env`:

```bash
BIND_ADDRESS=10.0.0.5      # the host's LAN address, or 0.0.0.0
```

and read this before you do: the admin port speaks **plain HTTP**. The bearer
token and the dashboard session cookie travel in every request, so without TLS
they cross the LAN in the clear. The expected setup is your own TLS-terminating
reverse proxy in front (the stack ships no proxy and no CA on purpose), with:

- an IP allow-list or VPN deciding who may reach the admin hostname at all;
- a hostname for the admin surface distinct from the public read API, so the two
  origins never share cookies;
- `ADMIN_SECURE_COOKIE=true` in the env file, so the session cookie is only ever
  sent over HTTPS;
- rate-limiting on `POST /admin/login` at the proxy.

The registrar prints a warning at startup whenever its admin bind is not
loopback — in the image that is always, which is the reminder that the
mapping, not the app, is your control. Never expose the admin port to the
internet. The [nginx example](../nginx/xrpl-registrar.conf.example) has an
optional `admin.` server block showing the shape.

`PUBLISH_READ_PORT` / `PUBLISH_ADMIN_PORT` change the host-side ports (useful
when another registrar already owns 51234/51235 on the same machine).

## 4. Using an existing Postgres

To point the image at a Postgres you already run instead of the bundled one,
drop the `postgres` service and give the registrar its URL. A
`compose.override.yml` next to `compose.yml` keeps that out of the tracked file:

```yaml
services:
  registrar:
    depends_on: !reset []
    environment:
      DATABASE_URL: postgres://user:password@db.internal:5432/xrpl_registrar
      DATABASE_SSL: !reset null # leave unset: TLS defaults on for a remote host
  postgres:
    profiles: [disabled]
```

Or run the image directly:

```bash
docker run -d --name xrpl-registrar --init --read-only --tmpfs /tmp \
  -e CLIO_ENDPOINT=wss://… -e ADMIN_TOKEN=… \
  -e DATABASE_URL=postgres://user:password@db.internal:5432/xrpl_registrar \
  -p 127.0.0.1:51234:51234 -p 127.0.0.1:51235:51235 xrpl-registrar:local
```

`DATABASE_POOL_MAX` and `DATABASE_SSL` apply as documented in the
[main README](../../README.md#configuration).

## Upgrades

```bash
git pull
docker compose -f deploy/docker/compose.yml up -d --build --wait
```

Compose rebuilds the image and replaces the registrar container; the Postgres
volume is untouched and migrations run on startup. `docker compose stop` sends
SIGTERM, which the server handles (tail stopped, pool drained) within its 4 s
watchdog, and a resumable sweep continues from its last checkpoint on restart.

## Backups

The archive lives in the `pgdata` volume. A consistent logical backup while
running:

```bash
docker compose -f deploy/docker/compose.yml exec -T postgres \
  pg_dump -U registrar -Fc xrpl_registrar > xrpl-registrar-$(date +%F).dump
```

Restore into an empty database (stop the registrar first):

```bash
docker compose -f deploy/docker/compose.yml stop registrar
docker compose -f deploy/docker/compose.yml exec -T postgres \
  pg_restore -U registrar -d xrpl_registrar --clean --if-exists < xrpl-registrar-YYYY-MM-DD.dump
docker compose -f deploy/docker/compose.yml start registrar
```

Everything derived is re-derivable from the retained raw blobs and the service
heals gaps on restart, but a dump is the fastest way back.

## Teardown

```bash
docker compose -f deploy/docker/compose.yml down      # keeps the archive (pgdata volume)
docker compose -f deploy/docker/compose.yml down -v   # deletes it
```

## Troubleshooting

- **`STORAGE_ENGINE=postgres but DATABASE_URL is unset`** — the container was
  started without the compose file (or the `environment:` block was removed).
  The image never falls back to the in-process engine; supply a URL.
- **`DATABASE_URL and DATABASE_DIR are both set`** — a `DATABASE_DIR` leaked into
  `deploy/docker/.env`, probably copied from the repo-root `.env`. Remove it.
- **TLS error connecting to `postgres`** — `DATABASE_SSL=false` is set in
  `compose.yml` for the bundled server; if you overrode `environment:` for an
  external Postgres, either that server offers TLS (default on for a
  non-loopback host) or you must say `DATABASE_SSL=false` deliberately.
- **`port is already allocated`** — another registrar (`pnpm serve`, or the
  systemd unit) owns 51234/51235 on the host. Set `PUBLISH_READ_PORT` /
  `PUBLISH_ADMIN_PORT`.
- **Container `unhealthy`** — `docker compose logs registrar`. The probe only
  needs the process and the database; a failing upstream shows in the logs but
  does not fail the probe.
- **colima: `Cannot connect to the Docker daemon`** — export `DOCKER_HOST` as in
  [Prerequisites](#prerequisites); a stale `DOCKER_HOST` in your shell profile
  silently overrides the active `docker context`.
