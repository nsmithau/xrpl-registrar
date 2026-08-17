/**
 * Schema migrations. Kept as inline SQL constants (not loose .sql files) so the
 * built artifact is self-contained and no asset copying is needed at build time.
 *
 * The data model follows the architecture outline: membership (`accounts`,
 * `account_issuance`) is kept separate from completeness (`coverage`), raw
 * blobs are retained so every derived value is re-derivable, and every
 * transaction carries provenance (source endpoint + fetch time).
 */

export interface Migration {
  readonly id: number;
  readonly name: string;
  readonly sql: string;
}

const CORE_SCHEMA = /* sql */ `
CREATE TABLE issuances (
  id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind                 TEXT NOT NULL CHECK (kind IN ('mpt', 'iou')),
  mpt_issuance_id      TEXT,
  currency             TEXT,
  issuer_account       TEXT,
  -- Ticker from the MPT's on-ledger metadata, captured at ingest (MPT only).
  ticker               TEXT,
  discovery_strategy   TEXT NOT NULL DEFAULT 'auto',
  requires_auth        BOOLEAN,
  backfill_from_ledger BIGINT NOT NULL DEFAULT 0,
  enabled              BOOLEAN NOT NULL DEFAULT TRUE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- An MPT is identified by mpt_issuance_id; an IOU by (currency, issuer_account).
  CONSTRAINT issuances_identity_shape CHECK (
    (kind = 'mpt' AND mpt_issuance_id IS NOT NULL AND currency IS NULL AND issuer_account IS NULL)
    OR
    (kind = 'iou' AND currency IS NOT NULL AND issuer_account IS NOT NULL AND mpt_issuance_id IS NULL)
  )
);
CREATE UNIQUE INDEX issuances_mpt_uq ON issuances (mpt_issuance_id) WHERE mpt_issuance_id IS NOT NULL;
CREATE UNIQUE INDEX issuances_iou_uq ON issuances (currency, issuer_account) WHERE kind = 'iou';

-- Every account ever in scope. Append-only; exited holders are never removed.
CREATE TABLE accounts (
  address           TEXT PRIMARY KEY,
  first_seen_ledger BIGINT
);

-- Why an account is in scope, and since when. An account may be in scope for
-- several issuances, entering at different times.
CREATE TABLE account_issuance (
  address                  TEXT NOT NULL REFERENCES accounts (address),
  issuance_id              BIGINT NOT NULL REFERENCES issuances (id),
  discovered_via           TEXT NOT NULL,
  first_acquisition_ledger BIGINT,
  PRIMARY KEY (address, issuance_id)
);

-- Deduplicated across issuances and accounts. Raw blobs are retained so every
-- derived value is reproducible from source.
CREATE TABLE transactions (
  hash            TEXT PRIMARY KEY,
  ledger_index    BIGINT NOT NULL,
  -- Clio's compact transaction identifier. Named clio_ctid because bare "ctid"
  -- collides with a Postgres system column.
  clio_ctid       TEXT,
  close_time_iso  TIMESTAMPTZ,
  tx_type         TEXT NOT NULL,
  mpt_issuance_id TEXT,
  tx_blob         BYTEA NOT NULL,
  meta_blob       BYTEA NOT NULL,
  source_endpoint TEXT NOT NULL,
  fetched_at      TIMESTAMPTZ NOT NULL
);
CREATE INDEX transactions_ledger_idx ON transactions (ledger_index);
CREATE INDEX transactions_mpt_idx ON transactions (mpt_issuance_id) WHERE mpt_issuance_id IS NOT NULL;

-- Join between transactions and in-scope accounts. Ingest idempotency key.
CREATE TABLE account_transactions (
  hash    TEXT NOT NULL REFERENCES transactions (hash),
  address TEXT NOT NULL REFERENCES accounts (address),
  PRIMARY KEY (hash, address)
);
CREATE INDEX account_transactions_addr_idx ON account_transactions (address);

-- Derived, per account per transaction per issuance. Reproducible from blobs.
CREATE TABLE balance_deltas (
  hash        TEXT NOT NULL REFERENCES transactions (hash),
  address     TEXT NOT NULL REFERENCES accounts (address),
  issuance_id BIGINT NOT NULL REFERENCES issuances (id),
  -- Signed amount as a string (MPTAmount serialises as a string as of xrpl v5).
  delta       TEXT NOT NULL,
  PRIMARY KEY (hash, address, issuance_id)
);

-- Completeness, kept separate from membership: which ledger range is guaranteed
-- complete for an account, and why that range and not more.
CREATE TABLE coverage (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  address     TEXT NOT NULL REFERENCES accounts (address),
  from_ledger BIGINT NOT NULL,
  to_ledger   BIGINT NOT NULL,
  reason      TEXT NOT NULL
);
CREATE INDEX coverage_addr_idx ON coverage (address);

-- Resumable backfill state: checkpoint the last marker after each page.
CREATE TABLE backfill_job (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  address     TEXT NOT NULL REFERENCES accounts (address),
  issuance_id BIGINT NOT NULL REFERENCES issuances (id),
  from_ledger BIGINT,
  to_ledger   BIGINT,
  last_marker JSONB,
  status      TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  -- 'issuer': a single account_tx sweep on the issuer that backfills every
  -- holder of the issuance at once (the primary bulk path). 'account': a sweep
  -- of one holder (used by the tail to backfill a newly-discovered holder).
  kind        TEXT NOT NULL DEFAULT 'account'
                CHECK (kind IN ('account', 'issuer')),
  tx_count    BIGINT NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (address, issuance_id)
);

CREATE TABLE reconciliation_run (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  issuance_id   BIGINT NOT NULL REFERENCES issuances (id),
  ran_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  passed        BOOLEAN NOT NULL,
  discrepancies INTEGER NOT NULL DEFAULT 0
);
`;

// Ledger close times, so balances can be reported by time (resolve a
// timestamp to the ledger in effect at/before it). Populated from the live
// tail's ledgerClosed events and a historical capture pass.
const LEDGERS_SCHEMA = /* sql */ `
CREATE TABLE ledgers (
  ledger_index   BIGINT PRIMARY KEY,
  close_time_iso TIMESTAMPTZ NOT NULL
);
CREATE INDEX ledgers_close_time_idx ON ledgers (close_time_iso);
`;

// Indexes for the hot per-issuance query paths. The natural keys lead with
// other columns (account_issuance PK is (address, issuance_id); balance_deltas
// PK is (hash, address, issuance_id)), so these queries scanned without them.
const PERF_INDEXES = /* sql */ `
-- countForIssuance, coverage join, transaction stats, backfill progress.
CREATE INDEX account_issuance_issuance_idx ON account_issuance (issuance_id);
-- archive_balance_at sums, archive_transactions scans, per-issuance transaction
-- stats, and the reconciler's per-account sums.
CREATE INDEX balance_deltas_issuance_addr_idx ON balance_deltas (issuance_id, address);
-- The backfill claim loop selects the next pending job per issuance once per
-- account (thousands of times per backfill); make each claim an index scan.
CREATE INDEX backfill_job_issuance_status_idx ON backfill_job (issuance_id, status, id);
`;

export const MIGRATIONS: readonly Migration[] = [
  { id: 1, name: "core_schema", sql: CORE_SCHEMA },
  { id: 2, name: "ledgers", sql: LEDGERS_SCHEMA },
  { id: 3, name: "perf_indexes", sql: PERF_INDEXES },
];
