# Deploying xrpl-registrar on Ubuntu

A native systemd deployment: the archive runs as a compiled `node` service under
a dedicated system user, with the embedded database persisted to disk. Tested on
Ubuntu 22.04 and 24.04 LTS.

Contents:

- [Layout](#layout)
- [1. Prerequisites (Node 22)](#1-prerequisites-node-22)
- [2. Install](#2-install)
- [3. Configure](#3-configure)
- [4. Start and verify](#4-start-and-verify)
- [5. TLS reverse proxy (public read API)](#5-tls-reverse-proxy-public-read-api)
- [6. Firewall](#6-firewall)
- [7. Admin dashboard over SSH](#7-admin-dashboard-over-ssh)
- [Upgrades](#upgrades)
- [Backups](#backups)
- [Uninstall](#uninstall)
- [Troubleshooting](#troubleshooting)

## Layout

| Path                                         | Purpose                                                | Owner            |
| -------------------------------------------- | ------------------------------------------------------ | ---------------- |
| `/opt/xrpl-registrar`                        | Application code + `dist/` build                       | `xrpl-registrar` |
| `/var/lib/xrpl-registrar`                    | Embedded database (PGlite) — the only persistent state | `xrpl-registrar` |
| `/etc/xrpl-registrar/xrpl-registrar.env`     | Configuration (mode `0600`)                            | `xrpl-registrar` |
| `/etc/systemd/system/xrpl-registrar.service` | systemd unit                                           | `root`           |

The service runs as the unprivileged, no-login system user `xrpl-registrar`. The
systemd unit is sandboxed (`ProtectSystem=strict`, `NoNewPrivileges`, an empty
capability set, a syscall allow-list); the data directory is the only writable
path.

## 1. Prerequisites (Node 22)

The only prerequisite the installer does not handle is the Node.js runtime.
Install Node 22 LTS from [NodeSource](https://github.com/nodesource/distributions):

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v        # v22.x
```

Node 22 ships `corepack`, which the installer uses to fetch a pinned pnpm — you
do **not** need to install pnpm yourself.

## 2. Install

Clone the repository and run the installer as root. It copies the code to
`/opt`, installs dependencies, builds `dist/`, drops dev-only dependencies,
creates the service user and data directory, and installs + enables the unit.

```bash
git clone https://github.com/nsmithau/xrpl-registrar.git
cd xrpl-registrar
sudo ./deploy/install.sh
```

The installer is **idempotent** — re-run it any time to upgrade (see
[Upgrades](#upgrades)). It never overwrites your config or touches your data.

## 3. Configure

On a first install the installer places a template at
`/etc/xrpl-registrar/xrpl-registrar.env`. Edit it and set, at minimum:

```bash
sudo nano /etc/xrpl-registrar/xrpl-registrar.env
```

- **`CLIO_ENDPOINT`** — WebSocket URL of a **full-history** Clio server. Required.
  A partial-history node makes the archive silently incomplete; the service logs
  a loud warning at startup if the endpoint does not report as Clio.
- **`ADMIN_TOKEN`** — bearer token for the admin API and dashboard. Leave unset
  to disable the admin port. Generate a strong value:

  ```bash
  openssl rand -hex 32
  ```

- **`CLIO_HTTP_ENDPOINT`** _(optional, recommended for large issuers)_ — an HTTP
  JSON-RPC Clio endpoint used to parallelise heavy backfill paging
  ([ADR-016](../docs/adr/adr-016-http-transport-for-backfill-paging.md)).

`DATABASE_DIR` is pre-set to `/var/lib/xrpl-registrar` and should not be changed.
Every variable is documented in
[`xrpl-registrar.env.example`](xrpl-registrar.env.example) and the
[main README](../README.md#configuration).

## 4. Start and verify

```bash
sudo systemctl start xrpl-registrar
sudo systemctl status xrpl-registrar        # should be active (running)
sudo journalctl -u xrpl-registrar -f        # follow startup + ingest logs
```

The service is already enabled to start on boot. A healthy startup logs the Clio
version, complete-ledger range, and `network_id`, then `Archive serving`.

Smoke-test the read API locally (loopback):

```bash
curl -s http://127.0.0.1:51234 -H 'content-type: application/json' \
  -d '{"method":"server_info","params":[{"api_version":2}]}' | head -c 400
```

## 5. TLS reverse proxy (public read API)

The read API binds to `127.0.0.1:51234` by default. To expose it to clients,
front it with nginx terminating TLS — do **not** set `HOST=0.0.0.0` with a plain
HTTP endpoint on the public internet.

```bash
sudo apt-get install -y nginx
sudo cp deploy/nginx/xrpl-registrar.conf.example \
        /etc/nginx/sites-available/xrpl-registrar.conf
sudo nano /etc/nginx/sites-available/xrpl-registrar.conf   # set server_name + cert paths
sudo ln -s /etc/nginx/sites-available/xrpl-registrar.conf /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

Obtain a certificate with certbot:

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d archive.example.com
```

Clients then connect to `wss://archive.example.com` (WebSocket) and
`https://archive.example.com` (HTTP JSON-RPC) exactly as they would a Clio
server. The proxy config forwards the WebSocket `Upgrade` and keeps long-lived
subscriptions open.

## 6. Firewall

Expose only SSH and HTTPS; the app ports stay on loopback.

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'    # 80 (redirect) + 443
sudo ufw enable
```

Do **not** open `51234` or `51235`. The admin port (`51235`) must never be
reachable from the network.

## 7. Admin dashboard over SSH

The admin API and dashboard are bound to `127.0.0.1:51235` and cannot be proxied
publicly. Reach them by forwarding the port over SSH from your workstation:

```bash
ssh -N -L 51235:127.0.0.1:51235 you@your-server
```

Then open <http://127.0.0.1:51235/> locally and paste your `ADMIN_TOKEN` to sign
in. Register issuances from there (or via the Admin API with a bearer token — see
the [main README](../README.md#registering-issuances-admin-api)).

## Upgrades

Pull the new code and re-run the installer. It rebuilds and restarts the running
service; your config and data are untouched.

```bash
cd xrpl-registrar
git pull
sudo ./deploy/install.sh
```

## Backups

All state is the single embedded-database directory. Back it up cold for a
consistent copy:

```bash
sudo systemctl stop xrpl-registrar
sudo tar czf xrpl-registrar-data-$(date +%F).tar.gz -C /var/lib xrpl-registrar
sudo systemctl start xrpl-registrar
```

Everything in the archive is re-derivable from the retained raw blobs, and the
service self-heals gaps on restart — but a cold copy of `/var/lib/xrpl-registrar`
is the fastest way to restore. To restore, stop the service, replace the
directory (preserving `xrpl-registrar` ownership), and start it again.

## Uninstall

```bash
sudo systemctl disable --now xrpl-registrar
sudo rm /etc/systemd/system/xrpl-registrar.service
sudo systemctl daemon-reload
sudo rm -rf /opt/xrpl-registrar /etc/xrpl-registrar
# Data — delete only if you are sure:
sudo rm -rf /var/lib/xrpl-registrar
sudo userdel xrpl-registrar
```

## Troubleshooting

- **`CLIO_ENDPOINT is required`** — the env file is missing or unset. Check
  `/etc/xrpl-registrar/xrpl-registrar.env` and that the unit's `EnvironmentFile`
  path matches.
- **`does not report as Clio`** at startup — `CLIO_ENDPOINT` points at an
  `xrpld` node, not a full-history Clio. History and Clio-only methods
  (`mpt_holders`) are not guaranteed; repoint it.
- **Service fails immediately with a seccomp / `Operation not permitted`
  error** — a hardened `SystemCallFilter` can occasionally reject a syscall on an
  unusual kernel. Comment out the `SystemCallFilter` and `SystemCallErrorNumber`
  lines in the unit, `systemctl daemon-reload`, and restart; please file an issue
  with your kernel version.
- **Build fails on `pnpm install`** — confirm `node -v` is 22+ and the server has
  outbound network access to the npm registry.
- **Logs** — everything goes to the journal: `journalctl -u xrpl-registrar` (add
  `-f` to follow, `-e` to jump to the end, `--since today`).
