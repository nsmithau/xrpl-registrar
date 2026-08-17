# ADR-011: License under Apache-2.0

**Date:** 2026-08-14

## Context

The project is being released as open source, and external adoption is an explicit objective (ADR-008 chose TypeScript for the same reason). It needs a license, and the PRD left both the license and the repository home open. Two properties matter more here than for a typical utility:

- **It sits on financial/ledger infrastructure.** Downstream adopters are institutions whose legal teams care about an explicit patent grant, not just copyright permission.
- **It is meant to be embedded in the adopter's own stack.** Issuers self-host it and wire it into their own — often proprietary — reporting and reconciliation systems (the whole thesis of ADR-001/005). A license that reaches into that stack would defeat the purpose.

## Decision

License under **Apache-2.0**. Ship the full `LICENSE` at the repo root (present) and state it in `package.json` and the README (both present).

Initial repository home is a **personal GitHub account** (author/maintainer `nsmithau`), not a corporate or foundation org. Apache-2.0 is the XRPLF house license, so donating the project to XRPLF later is a governance move, not a relicense — the choice deliberately keeps that door open.

## Options Considered

| Option | Verdict |
|--------|---------|
| **Apache-2.0** *(chosen)* | Permissive like MIT, **plus an express patent license and a patent-retaliation clause.** Matches Horizon (the conceptual predecessor, ADR-001) and the XRPL ecosystem norm (`xrpl.js`, Clio, `xrpld`, XRPLF projects). The patent grant is the deciding factor for institutional adopters. |
| MIT / BSD | Rejected. Fine permissive licenses, but **no explicit patent grant** — a gap that matters for infrastructure touching financial systems and for corporate legal review. Apache-2.0 is a strict superset of what MIT offers here. |
| GPL / AGPL (copyleft) | Rejected. The reciprocal obligations attach to exactly the proprietary reporting stacks this is designed to be embedded in. AGPL's network-use trigger is especially hostile to a self-hosted service and would deter the institutional adopters the project targets. |
| BSL / SSPL (source-available) | Rejected. Not OSI-approved open source. A non-open license directly undercuts the external-adoption objective and the "run it yourself, under your own control" thesis. |

## Consequences

- Inbound contributions are under Apache-2.0 by default (§5). Whether to add a DCO sign-off or a CLA is a follow-on to settle before accepting outside contributions; note it, don't pre-decide it here.
- **Dependencies must stay license-compatible** (permissive). The bundled third-party assets are already compatible and attributed in place: Lucide icons (ISC) and IBM Plex (OFL) in the dashboard. A copyleft runtime dependency would be a licensing regression and should be caught in review.
- No `NOTICE` file exists yet. Apache-2.0 does not require one, but if third-party attributions accumulate, a root `NOTICE` is the conventional home; revisit if the attribution list outgrows inline comments.
- Donating to XRPLF (or any org) later requires no license change — only a repository transfer and a maintainer/governance handover.
