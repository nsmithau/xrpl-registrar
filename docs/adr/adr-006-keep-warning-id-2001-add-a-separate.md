# ADR-006: Keep warning id 2001; add a separate id for filtered-archive status

**Date:** 2026-08-12

## Context

Clio attaches a `warnings` array to responses, with id `2001` declaring "this is a clio server… only serves validated data." The natural move is to reuse that slot with our own message declaring the archive is filtered.

## Decision

Continue emitting id `2001` **unchanged**. Add a _separate_ warning under a new id flagging that this is a filtered archive. Use a documented provisional high id and propose a registered id to XRPLF.

**As implemented:** the filtered-archive warning is id `65001` and is a compact marker with **no** `details` — the full tracked scope is returned only where it is actionable, in the `notInArchive` error's `details` (ADR-005), rather than on every response. Sibling provisional ids in the same range: `65002` (response forwarded upstream, not archive-sourced), `65003` (requested range exceeds guaranteed coverage), `65004` (`gateway_balances` does not report the issuer's own holdings — ADR-017).

## Rationale

The API documentation states explicitly: _"Do not write software that relies on the contents of this message; use the `id` (and `details`, if applicable) to identify the warning instead."_ Shipping id 2001 with rewritten prose therefore gives correctly-written clients no signal at all, while breaking incorrectly-written clients that string-match. It is the worst of both.

Keeping 2001 is also substantively correct: we serve only validated data and carry the same `ledger_index: current` caveat, so client code paths that branch on Clio behaviour will take the right path against us.

Squatting on an unallocated low id risks a real collision — 1001, 1002, 2001 and 2002 are allocated and XRPLF will keep assigning in those ranges.

## Consequences

- An XRPLF proposal for a registered warning id becomes an external communication item, and is easier if the repo lives in XRPLF (open question).
- **The warning is not a substitute for ADR-005's hard error.** Warnings are advisory, the docs describe 2001 as "generally safe to ignore," and client handling is inconsistent. Warning for disclosure; error for correctness.
