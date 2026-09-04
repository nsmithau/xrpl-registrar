# ADR-002: Source all history from Clio, never from `xrpld`

**Date:** 2026-08-12

## Context

The driving issuer first attempted to run their own full-history `xrpld` node and could not make it work — the P2P backfill of that volume takes months, if it converges at all.

## Decision

Clio is the sole source of historical transaction data.

## Rationale

A live `server_info` against a public full-history Clio cluster shows the two components' history ranges:

| Component             | `complete_ledgers`                                                              |
| --------------------- | ------------------------------------------------------------------------------- |
| Clio                  | `32570-106232907` (full history, contiguous from the earliest surviving ledger) |
| The `xrpld` behind it | `105423178-106232922` (~800k ledgers, a few weeks)                              |

Full history lives in Clio's database. The P2P node feeding it retains only a short window. No amount of effort running `xrpld` produces what the issuer needs.

## Consequences

- Every read path targets Clio, and Clio-only methods (`mpt_holders`) are available to us.
- We inherit Clio's behaviours, including its forwarding semantics — see ADR-004.
- Clio version matters. The reference endpoint runs 2.7.1, which has `tx_type` filtering on `account_tx` (Clio 2.0+) and `mpt_holders`. Nothing in the requirements is blocked on a Clio upgrade.
