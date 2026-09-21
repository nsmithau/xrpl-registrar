# xrpl-registrar container image — Postgres-only (ADR-019).
#
# The image pins STORAGE_ENGINE=postgres: a container's filesystem is ephemeral,
# so falling back to the in-process PGlite engine would mean an archive that
# evaporates on restart. Without DATABASE_URL the process refuses to start.
#
#   docker build -t xrpl-registrar .
#   docker run --rm -e CLIO_ENDPOINT=wss://… -e DATABASE_URL=postgres://… \
#     -e ADMIN_TOKEN=… -p 127.0.0.1:51234:51234 -p 127.0.0.1:51235:51235 xrpl-registrar
#
# The compose stack in deploy/docker/ wires a Postgres alongside it.

ARG NODE_VERSION=22

# ---- base: pnpm pinned from package.json's packageManager field --------------
FROM node:${NODE_VERSION}-slim AS base
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN npm install -g "pnpm@$(node -p "require('./package.json').packageManager.split('@')[1]")" \
  && pnpm --version

# ---- build: full install + tsc ------------------------------------------------
FROM base AS build
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

# ---- prod-deps: runtime dependencies only -------------------------------------
FROM base AS prod-deps
RUN pnpm install --prod --frozen-lockfile

# ---- runtime -------------------------------------------------------------------
FROM node:${NODE_VERSION}-slim AS runtime
ENV NODE_ENV=production \
    # Postgres only — see the header comment.
    STORAGE_ENGINE=postgres \
    # Bind both listeners on all container interfaces: Docker's bridge network
    # cannot reach a loopback-bound port. Exposure to the outside is decided at
    # the host port mapping (compose: BIND_ADDRESS), not here. The admin port
    # speaks plain HTTP — put a TLS-terminating proxy in front and set
    # ADMIN_SECURE_COOKIE=true before anyone but the local operator uses it.
    HOST=0.0.0.0 \
    ADMIN_HOST=0.0.0.0 \
    PORT=51234 \
    ADMIN_PORT=51235
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json LICENSE README.md ./
USER node
EXPOSE 51234 51235
# GET /healthz: 200 while the process is up and the database answers. It does
# not depend on the upstream Clio link, so an upstream outage does not restart
# the container. No curl in the image — use node's fetch.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||51234)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/server.js"]
