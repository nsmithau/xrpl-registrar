#!/usr/bin/env bash
#
# Install (or upgrade) xrpl-registrar as a systemd service on Ubuntu.
#
# Run as root from a checkout of the repository:
#
#   git clone https://github.com/nsmithau/xrpl-registrar.git
#   cd xrpl-registrar
#   sudo ./deploy/install.sh
#
# Idempotent: safe to re-run to upgrade. It copies the code to /opt, installs
# dependencies, builds, installs the systemd unit, and (on upgrade) restarts a
# running service. It never overwrites your /etc config or touches your data.
#
# Prerequisites: Node.js >= 22 with corepack (see deploy/README.md for the
# NodeSource one-liner). Everything else is handled here.
set -euo pipefail

APP_USER=xrpl-registrar
APP_GROUP=xrpl-registrar
APP_DIR=/opt/xrpl-registrar
DATA_DIR=/var/lib/xrpl-registrar
ETC_DIR=/etc/xrpl-registrar
ENV_FILE="$ETC_DIR/xrpl-registrar.env"
UNIT=/etc/systemd/system/xrpl-registrar.service
PNPM_VERSION=9.15.0

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root (e.g. sudo ./deploy/install.sh)"

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f "$SRC/package.json" ] || die "cannot find the repo root from $SRC"

# --- Prerequisites: Node 22+ and corepack ---
command -v node >/dev/null 2>&1 || die "Node.js is not installed. See deploy/README.md (NodeSource) to install Node 22."
NODE_MAJOR="$(node -v | sed 's/^v\([0-9]*\).*/\1/')"
[ "$NODE_MAJOR" -ge 22 ] || die "Node.js >= 22 required, found $(node -v). See deploy/README.md."
command -v corepack >/dev/null 2>&1 || die "corepack not found (ships with Node 22). Try: sudo corepack enable"
say "Using $(node -v), pinning pnpm@$PNPM_VERSION via corepack"
corepack enable >/dev/null 2>&1 || true
corepack prepare "pnpm@$PNPM_VERSION" --activate >/dev/null

# rsync is used to sync the checkout to /opt; install it if missing.
if ! command -v rsync >/dev/null 2>&1; then
  say "Installing rsync"
  apt-get update -qq && apt-get install -y -qq rsync
fi

# --- Service account ---
getent group "$APP_GROUP" >/dev/null || { say "Creating group $APP_GROUP"; groupadd --system "$APP_GROUP"; }
if ! id "$APP_USER" >/dev/null 2>&1; then
  say "Creating system user $APP_USER"
  useradd --system --gid "$APP_GROUP" --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
fi

# --- Copy code to $APP_DIR ---
if [ "$SRC" != "$APP_DIR" ]; then
  say "Syncing code to $APP_DIR"
  mkdir -p "$APP_DIR"
  # --delete keeps $APP_DIR a clean mirror; excluded paths (data, node_modules)
  # are protected from deletion so persistent state and caches survive upgrades.
  rsync -a --delete \
    --exclude '.git' --exclude 'node_modules' --exclude 'dist' \
    --exclude 'data' --exclude '.env' --exclude '*.log' \
    "$SRC"/ "$APP_DIR"/
else
  say "Installer running from $APP_DIR; skipping code sync"
fi
chown -R "$APP_USER:$APP_GROUP" "$APP_DIR"

# --- Install deps + build (as the service user) ---
say "Installing dependencies and building (this can take a minute)"
run_as_app() { sudo -H -u "$APP_USER" env HOME="$APP_DIR" PATH="$PATH" bash -c "$1"; }
run_as_app "cd '$APP_DIR' && corepack pnpm@$PNPM_VERSION install --frozen-lockfile"
run_as_app "cd '$APP_DIR' && corepack pnpm@$PNPM_VERSION run build"
# Drop devDependencies (typescript, tsx, eslint, vitest…) — the compiled service
# runs on plain node and needs only the runtime deps.
run_as_app "cd '$APP_DIR' && corepack pnpm@$PNPM_VERSION prune --prod"
[ -f "$APP_DIR/dist/server.js" ] || die "build did not produce dist/server.js"

# --- Data directory (writable by the service; the systemd unit grants it) ---
say "Ensuring data directory $DATA_DIR"
install -d -o "$APP_USER" -g "$APP_GROUP" -m 0750 "$DATA_DIR"

# --- Config ---
install -d -o root -g "$APP_GROUP" -m 0750 "$ETC_DIR"
if [ -f "$ENV_FILE" ]; then
  say "Keeping existing config $ENV_FILE"
  CONFIGURED=1
else
  say "Installing config template to $ENV_FILE (edit before starting)"
  install -o "$APP_USER" -g "$APP_GROUP" -m 0600 "$APP_DIR/deploy/xrpl-registrar.env.example" "$ENV_FILE"
  CONFIGURED=0
fi

# --- systemd unit ---
say "Installing systemd unit"
install -o root -g root -m 0644 "$APP_DIR/deploy/systemd/xrpl-registrar.service" "$UNIT"
systemctl daemon-reload
systemctl enable xrpl-registrar >/dev/null 2>&1 || true

# --- Start or restart ---
echo
if systemctl is-active --quiet xrpl-registrar; then
  say "Restarting the running service"
  systemctl restart xrpl-registrar
  say "Done. Upgraded and restarted."
elif [ "${CONFIGURED:-0}" = "1" ]; then
  say "Starting the service"
  systemctl start xrpl-registrar
  say "Done. Service started."
else
  say "Done. Next steps:"
  cat <<EOF

  1. Edit the config and set at least CLIO_ENDPOINT and ADMIN_TOKEN:
       sudo nano $ENV_FILE
       # generate a token:  openssl rand -hex 32

  2. Start it:
       sudo systemctl start xrpl-registrar

  3. Watch the logs:
       sudo journalctl -u xrpl-registrar -f

  The read API listens on 127.0.0.1:51234 by default. Front it with TLS using
  deploy/nginx/xrpl-registrar.conf.example. Reach the admin dashboard on
  127.0.0.1:51235 via an SSH tunnel — see deploy/README.md.
EOF
fi
