# ADR-003: Use a public Clio cluster for Alpha and Beta

**Date:** 2026-08-12
**Status:** Accepted, with a mandatory review point

## Context

xrpl.org documents the public XRPL clusters as "not for sustained or business use," with no SLA and no rate-limit guarantee. The archive backs a regulatory filing.

## Decision

Alpha and Beta run against a public full-history Clio cluster. The production source must be resolved before the issuer generates a statement they will file — by the production acceptance gate, not before Alpha.

## Trade-off Analysis

Capability is not the issue and was verified directly: Clio 2.7.1, contiguous full history from ledger 32570, `mpt_holders` and `tx_type` filtering present, `validated_ledger.age` of 5s. The residual risk is entirely policy and rate limiting. Against that, using a public cluster removes a procurement dependency from the critical path and lets the build start immediately.

## Consequences

- **Backfill is the heaviest load we can point at a shared, publicly-operated cluster.** Ship conservative default concurrency and honest backoff. Brief the cluster operators before the first full backfill run. Note the reference endpoint already shows `jq_trans_overflow: 3501` and `peer_disconnects_resources: 535` under normal conditions — it sheds load.
- **Per-record provenance is the mitigation** (see ADR-005 consequences). Everything ingested from the public cluster stays identifiable and re-verifiable against a supportable source later, without a full re-ingest. This converts the decision from hidden assumption into tracked debt.
- Endpoint pooling and failover become more valuable earlier than they otherwise would.
