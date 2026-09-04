# Security policy

`xrpl-registrar` is self-hosted software that stores holder-level financial
history for the token issuances an operator registers. It handles **no key
material** and is read-only against the ledger, but its archive and its admin
surface are sensitive: the admin port exposes account addresses and archive
scope, and the read API's completeness guarantees are what make the data usable
for regulatory reporting. Treat the following as security-relevant:

- Any way to read the admin API or dashboard without the bearer token or a
  valid session cookie, or to bind the admin port to a non-loopback address.
- Any way to make the archive return a **plausible wrong answer**: an empty
  result where `notInArchive` or `outOfCoverage` was required, a coverage range
  that over-claims completeness, or a balance that disagrees with the retained
  raw metadata.
- Injection or resource-exhaustion via the public JSON-RPC / WebSocket API.
- Supply-chain issues in the dependency tree or the `deploy/` installer.

## Reporting a vulnerability

Please **do not open a public issue** for anything you believe is a
vulnerability. Use GitHub's private vulnerability reporting on this repository
("Security" → "Report a vulnerability"), which reaches the maintainer directly.

Include what you can: affected version or commit, a reproduction or proof of
concept, and the impact you believe it has. You will get an acknowledgement
within a few days and updates as the fix progresses. Coordinated disclosure is
appreciated; credit is given in the release notes unless you prefer otherwise.

## Scope and expectations

- Only the latest commit on `main` is supported; there are no maintained
  release branches yet (the project is pre-1.0).
- Operational hardening is the operator's responsibility and is documented in
  [`deploy/README.md`](deploy/README.md): keep the admin port on loopback and
  reach it over SSH, front the read API with TLS, and never commit
  `ADMIN_TOKEN`.
- Findings about the **upstream** Clio or `xrpld` servers this project talks to
  should go to those projects, not here.
