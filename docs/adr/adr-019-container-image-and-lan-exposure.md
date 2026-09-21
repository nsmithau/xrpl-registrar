# ADR-019: Container image is Postgres-only; exposure is decided at the host, not in the app

**Status:** Accepted — implemented. Decider: nsmithau. **Amends** [ADR-009](adr-009-operator-ui-is-read-only-and-admin.md) (the admin surface is loopback _by default_, no longer _always_).

## Context

Two deployment needs arrived together. Operators want a **container image**
(ROADMAP #6) — and a container's filesystem is ephemeral, so the default
in-process PGlite engine (ADR-010) would give them an archive that evaporates
on restart. And a LAN deployment wants the **dashboard and admin API reachable
without an SSH tunnel**, with the network team running their own TLS proxy and
certificate authority in front.

Both collide with rules the codebase enforced structurally: the admin server
was hard-bound to `127.0.0.1`, the nginx example refused to proxy it, and
storage silently fell back to in-memory PGlite when nothing was configured.
Those rules exist for a reason — the admin port carries the bearer token and
session cookie over **plain HTTP**, and surfaces account addresses and archive
scope (PRD: a controlled surface) — so loosening them needs a recorded
decision, not a config knob added in passing.

## Decision

1. **The image pins the storage engine.** `STORAGE_ENGINE=postgres` is baked
   into the image; without `DATABASE_URL` the process refuses to start. The
   pin is a general config rule (`postgres` requires a URL, `pglite` forbids
   one) so a systemd deployment can use it too, but the image is where it is
   load-bearing. PGlite stays the default outside containers (ADR-010).
2. **Bind addresses are configuration; exposure is decided at the host.**
   `ADMIN_HOST` (default `127.0.0.1`) joins `HOST`. Inside the image both are
   `0.0.0.0`, because Docker's bridge network cannot reach a loopback bind. The
   compose stack publishes both ports on `BIND_ADDRESS`, **loopback by
   default** — the same posture as systemd — and a LAN address or `0.0.0.0`
   opens them. The app cannot know which; when its own admin bind is not
   loopback it prints a warning saying what the operator has taken on.
3. **The stack ships no proxy and no CA.** TLS termination, IP allow-listing,
   login rate-limiting and certificates are the operator's proxy's job; the app
   adds only `ADMIN_SECURE_COOKIE`, so the dashboard session cookie is marked
   `Secure` once served over HTTPS. Docs say plainly that without that proxy
   the admin token crosses the LAN unencrypted — their call, our disclosure.
4. **Health is local.** `GET /healthz` answers 200 while the process is up and
   the database answers, independent of the upstream Clio link. An upstream
   outage must not make the container restart and abandon a resumable sweep,
   and the archive keeps serving local data regardless.
5. **One replica per database.** The upstream concurrency governor is
   in-process (ROADMAP #3); the compose file runs a single registrar and says
   why.

## Options considered

| Option                                                                          | Verdict                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Keep admin hard-bound to loopback; SSH tunnel only                              | Rejected. Unworkable in a container (bridge network) and does not meet the LAN requirement. Stays the _default_.                                                                                                               |
| Publish the admin port on `0.0.0.0` by default                                  | Rejected. Plain HTTP with the token in every request; the default must stay private and the widening must be an explicit operator act.                                                                                         |
| Bundle a TLS proxy (Caddy/nginx) in the compose stack                           | Rejected for now. The target deployment already has a proxy and a CA team; a second proxy in the stack duplicates their controls and puts certificate handling in our runbook. Nothing prevents adding one as an opt-in later. |
| `network_mode: host` to keep the loopback bind                                  | Rejected. Linux-only (not colima/Docker Desktop), and it publishes _every_ port the process opens.                                                                                                                             |
| PGlite in a mounted volume inside the container                                 | Rejected. Single-writer WASM Postgres in a volume adds nothing over a Postgres container and invites two-process corruption; the networked engine already exists (ADR-010).                                                    |
| **Postgres-only image; bind configurable; publish on host loopback by default** | Chosen. Fails closed on storage, keeps the private default, and hands exposure to the layer that controls the network.                                                                                                         |

## Consequences

- ADR-009's "never publicly exposed by default" holds; "always loopback" is
  replaced by a documented opt-in. The systemd env template and the nginx
  example gain the same `ADMIN_HOST` / proxied-admin guidance so the two
  deployment paths agree.
- `HOST` and `ADMIN_HOST` inside the image are not operator knobs; the env
  template says so. The variables an operator sets are `BIND_ADDRESS` and the
  two published ports.
- `DATABASE_SSL=false` must be explicit in the compose stack: `postgres` is a
  non-loopback host, for which the app defaults TLS on, and the bundled server
  has none. An external managed Postgres keeps the TLS-on default.
- The image carries PGlite's WASM although it can never use it (it is a
  runtime dependency of the package). Splitting the engines into optional
  dependencies would shrink the image; not worth it until size matters.
- CI builds the image and checks the fail-closed pin; the full stack smoke
  (compose up, register, `pnpm verify`) needs a live Clio and stays a manual
  step in the runbook.
