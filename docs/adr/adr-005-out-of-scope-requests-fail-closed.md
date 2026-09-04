# ADR-005: Out-of-scope requests fail closed

**Date:** 2026-08-12

## Context

Mirroring Clio creates a semantic gap. Clio returns real data for any account; we hold only accounts in scope for a configured issuance. A client cannot distinguish "this account had no transactions" from "this account is not in my archive."

## Decision

Out-of-scope requests are governed by a `forwardUnknownAccounts` switch, defaulting to **false**.

- **Closed (default):** return a distinct `notInArchive` error carrying the archive scope in `details`.
- **Open:** forward to a configured public node, set `forwarded: true`, and attach a warning (id `65002`) stating the payload is not archive-sourced and carries no completeness or provenance guarantee.

**As implemented:** the switch is an `ArchiveApi` constructor option, not an environment variable — `serve` never sets it, so a production deployment cannot enable forwarding of out-of-scope reads at all; the open mode exists for tests and embedded use. Exposing it via configuration would be a deliberate follow-on, not an oversight to patch.

## Options Considered

| Option                                       | Verdict                                                                                                                                                                                                                                                                                |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Return an empty result set                   | **Rejected outright.** Silent wrong answer. A holder with a real balance appears to have had no activity.                                                                                                                                                                              |
| Reuse `actNotFound`                          | **Rejected.** It asserts the account does not exist on the ledger — a different and false claim. Conflating the two is how someone eventually concludes a holder had no activity.                                                                                                      |
| Always forward transparently                 | **Rejected as default.** If a statement generator queries an out-of-scope account and quietly gets an answer proxied from a public node at query time, we have reintroduced exactly the dependency the archive exists to remove — except invisibly, because the response looks normal. |
| Fail closed with a distinct error _(chosen)_ | Loud failure is the only behaviour that preserves the guarantee. Forwarding stays available for evaluation and development.                                                                                                                                                            |

## Consequences

- Consistent with "empty configuration is an error" — the system fails closed throughout.
- **The same problem exists in a second form: ledger range.** A whitelisted account queried for a period before the archive's floor returns real but incomplete data. Report true `ledger_index_min`/`max` rather than echoing `-1`, and warn when a requested range exceeds coverage. Partial history for an in-scope account is _more_ dangerous than no history for an out-of-scope one, because nothing looks wrong.
- Requires per-account coverage metadata: what range is guaranteed, and why the account is in scope.
