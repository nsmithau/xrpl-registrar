# ADR-011: License under ISC

**Date:** 2026-08-14. **Amended:** 2026-08-19 — decision changed from Apache-2.0 to ISC (see note below).

> **Amendment note.** The original decision was Apache-2.0. It rested partly on a
> factual error: it claimed Apache-2.0 was "the XRPL ecosystem norm (`xrpl.js`,
> Clio, `xrpld`)." Those are all **ISC** — only the other-ledger indexer that served
> as the _conceptual_ predecessor (ADR-001) is Apache-2.0. Corrected here, the ecosystem-consistency
> argument points the other way, and this project deliberately mirrors Clio's
> API and depends on `xrpl.js`. The decision is changed to **ISC** to match the
> stack it sits in, consciously trading away Apache-2.0's express patent grant.

## Context

The project is being released as open source, and external adoption is an explicit objective (ADR-008 chose TypeScript for the same reason). It needs a license, and the PRD left both the license and the repository home open. Two properties matter more here than for a typical utility:

- **It sits directly on the XRPL server stack.** It mirrors Clio's API (ADR-004) and is built on `xrpl.js`; `xrpld`, `clio`, and `xrpl.js` are all licensed **ISC**. Matching the license of the software it imitates and depends on is the strongest signal to contributors and adopters, and avoids friction if any part is ever upstreamed.
- **It is meant to be embedded in the adopter's own stack.** Issuers self-host it and wire it into their own — often proprietary — reporting and reconciliation systems (the whole thesis of ADR-001/005). A license that reaches into that stack would defeat the purpose, so a permissive license is required.

The competing consideration is a patent grant: Apache-2.0 carries an express patent license and retaliation clause; ISC (like MIT/BSD) does not. For infrastructure touching financial systems that is a real factor. It is outweighed here by ecosystem consistency: the XRPL core servers this archive stands in for already ship to the same institutions under ISC with no separate patent grant, so aligning with them is the more coherent posture than adopting a different license than the servers being mirrored.

## Decision

License under **ISC** — the license of `xrpld`, `clio`, and `xrpl.js`. Ship the full `LICENSE` at the repo root, and state it in `package.json` and the README.

Initial repository home is a **personal GitHub account** (author/maintainer `nsmithau`), not a corporate or foundation org. ISC is OSI-approved and permissive, so donating the project to XRPLF later is a governance move (repository transfer + maintainer handover), not a relicense.

## Options Considered

| Option                        | Verdict                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ISC** _(chosen)_            | The license of the XRPL core (`xrpld`, `clio`) and `xrpl.js` — the exact stack this project mirrors and depends on. Permissive, OSI-approved, minimal. Ecosystem consistency is the deciding factor.                                                                                                                                                                          |
| Apache-2.0                    | Rejected, narrowly. Its express patent grant + retaliation clause are genuinely valuable for financial infrastructure — and it is the XRPLF house license for some newer TypeScript libraries and the license of the conceptual predecessor considered in ADR-001. But the XRPL servers this archive imitates are ISC; matching them matters more here than the patent grant. |
| MIT / BSD                     | Rejected. Functionally equivalent to ISC (permissive, no patent grant), but ISC is the specific convention of the XRPL core, so it is the more consistent choice.                                                                                                                                                                                                             |
| GPL / AGPL (copyleft)         | Rejected. The reciprocal obligations attach to exactly the proprietary reporting stacks this is designed to be embedded in. AGPL's network-use trigger is especially hostile to a self-hosted service and would deter the institutional adopters the project targets.                                                                                                         |
| BSL / SSPL (source-available) | Rejected. Not OSI-approved open source. A non-open license directly undercuts the external-adoption objective and the "run it yourself, under your own control" thesis.                                                                                                                                                                                                       |

## Consequences

- **No express patent grant.** This is the conscious trade for ISC. It matches the XRPL core's own posture; an adopter with heightened patent concerns can seek separate assurances. Documented here so the choice is not mistaken for an oversight (as the Apache examples in the original version were).
- Inbound contributions are under ISC by default. Whether to add a DCO sign-off or a CLA is a follow-on to settle before accepting outside contributions; note it, don't pre-decide it here.
- **Dependencies must stay license-compatible** (permissive). The bundled third-party assets are already compatible and attributed in place: Lucide icons (ISC) and IBM Plex (OFL) in the dashboard. A copyleft runtime dependency would be a licensing regression and should be caught in review.
- No `NOTICE` file is needed (ISC has no such convention); a short copyright line lives in `LICENSE` and the README.
- Donating to XRPLF (or any org) later requires no license change — only a repository transfer and a maintainer/governance handover.
