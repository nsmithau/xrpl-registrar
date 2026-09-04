# Contributing

Thanks for your interest. This project maintains data that backs regulatory
filings, so correctness is weighted above convenience throughout — please read
the design principles in the [README](README.md#design-principles) and skim the
[ADRs](docs/adr/) before proposing a change in behaviour.

## Development setup

Requires Node 22+ (see `.nvmrc`) and [pnpm](https://pnpm.io/).

```bash
pnpm install
pnpm test              # unit tests — offline, in-process Postgres (PGlite)
pnpm typecheck
pnpm lint
pnpm build
```

The live smoke test needs a full-history Clio endpoint:

```bash
CLIO_ENDPOINT=wss://<full-history-clio> pnpm test:integration
```

To run the service locally, copy `.env.example` to `.env`, set `CLIO_ENDPOINT`
and `ADMIN_TOKEN`, and run `pnpm serve` (or `pnpm dev` for a watch-mode
restart on change — note that restarts interrupt an in-flight backfill; the job
resumes from its last checkpoint, but for a clean long ingest prefer `pnpm serve`).

## Making changes

- **Tests first for behaviour.** Every ingest, coverage, and API-shape change
  needs a unit test under `test/` mirroring the `src/` path. The suite runs
  entirely offline against an in-memory PGlite, so there is no excuse for an
  untested path.
- **Check the ADRs.** Several obvious-looking simplifications were considered
  and rejected for reasons that are not visible from the call site. If a change
  contradicts an ADR, amend or supersede it explicitly in the same pull request
  ([ADR-007](docs/adr/adr-007-traversal-is-the-general-discovery-algorithm-issuer.md)
  shows the pattern). New design decisions get a new ADR and an index entry.
- **Fail closed.** Never turn an error into an empty result; never let coverage
  over-claim. If a change could make a partial archive look complete, it is
  wrong.
- **Method classes.** When adding an API method, decide first whether it is an
  archive-scoped read (scope-checked), a node-state method (local or
  forwarded), or a submission (always forwarded).
- **Style.** `pnpm lint` must pass with no errors (`no-explicit-any` is an
  error). Run `pnpm format` on the files you touch. Write `xrpld` rather than
  the legacy server name in prose you author.
- **Commits.** Small, focused commits with a descriptive subject and a body
  that says _why_. Reference the ADR or roadmap item where relevant.

## Pull requests

1. Fork and branch from `main`.
2. Make sure `pnpm typecheck && pnpm lint && pnpm test && pnpm build` pass
   locally; CI runs the same on Node 22 and 24.
3. Open a PR describing the change, the failure mode it fixes or the capability
   it adds, and how you verified it. Link any ADR you touched.

Contributions are accepted under the project's [ISC license](LICENSE).

## Reporting bugs and security issues

Bugs and feature requests go in the issue tracker. Anything that looks like a
vulnerability — especially a way to get a plausible wrong answer out of the
archive or to reach the admin surface without credentials — should follow
[SECURITY.md](SECURITY.md) instead of a public issue.
