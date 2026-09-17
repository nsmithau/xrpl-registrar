import Big from "big.js";

import type { Database, Queryable } from "../db/database.js";

export interface DeltaRow {
  readonly hash: string;
  readonly address: string;
  /** Integer (MPT, bigint) or decimal (IOU, string) — stored as text either way. */
  readonly delta: bigint | string;
}

/**
 * Persists derived per-transaction balance deltas and sums them.
 *
 * Deltas are reproducible from raw blobs, so they are stored as a derived,
 * re-derivable table. The key is `(hash, address, issuance_id)`; re-derivation
 * overwrites with the same value, so it is idempotent.
 */
export class BalanceDeltaRepository {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /** Upsert a batch of deltas for an issuance in one transaction. Ensures the
   * account rows exist first (deltas reference accounts). */
  async upsertMany(issuanceId: number, rows: readonly DeltaRow[]): Promise<void> {
    if (rows.length === 0) return;
    await this.#db.transaction((tx) => insertDeltasMany(tx, issuanceId, rows));
  }

  /** Summed integer (MPT) balance per account, derived from the deltas. */
  async balanceByAccount(issuanceId: number): Promise<Map<string, bigint>> {
    const out = new Map<string, bigint>();
    for (const [address, bal] of await this.#sums(issuanceId)) out.set(address, BigInt(bal));
    return out;
  }

  /** Summed decimal (IOU) balance per account, derived from the deltas. */
  async decimalBalanceByAccount(issuanceId: number): Promise<Map<string, Big>> {
    const out = new Map<string, Big>();
    for (const [address, bal] of await this.#sums(issuanceId)) out.set(address, new Big(bal));
    return out;
  }

  async #sums(issuanceId: number): Promise<Array<[string, string]>> {
    const { rows } = await this.#db.query<{ address: string; bal: string }>(
      `SELECT address, sum(delta::numeric)::text AS bal
       FROM balance_deltas WHERE issuance_id = $1 GROUP BY address`,
      [issuanceId],
    );
    return rows.map((r) => [r.address, r.bal]);
  }

  async count(issuanceId: number): Promise<number> {
    const { rows } = await this.#db.query<{ n: number | string }>(
      "SELECT count(*)::bigint AS n FROM balance_deltas WHERE issuance_id = $1",
      [issuanceId],
    );
    return Number(rows[0]!.n);
  }
}

/** Upsert one delta on a caller-supplied transaction/connection, ensuring the
 * account row exists first. Idempotent on (hash, address, issuance_id). */
export async function insertDelta(tx: Queryable, issuanceId: number, row: DeltaRow): Promise<void> {
  await insertDeltasMany(tx, issuanceId, [row]);
}

/**
 * Upsert a batch of deltas for one issuance on a caller-supplied transaction in
 * two multi-row statements — one for the referenced `accounts`, one for the
 * `balance_deltas` — instead of two statements per row. On single-threaded
 * PGlite that turns a transaction touching N accounts from 2N serialized
 * round-trips into 2. Idempotent on (hash, address, issuance_id).
 *
 * Both statements insert in primary-key order. On the networked Postgres
 * engine these run as concurrent transactions over overlapping accounts and
 * hashes, and a consistent lock order is what keeps that from deadlocking —
 * see the note on `insertTransactionRowsMany`. Statements are chunked to stay
 * under Postgres's 65535-parameter limit, matching the transaction batch path.
 */
export async function insertDeltasMany(
  tx: Queryable,
  issuanceId: number,
  rows: readonly DeltaRow[],
): Promise<void> {
  if (rows.length === 0) return;

  const addresses = [...new Set(rows.map((r) => r.address))].sort();
  await insertChunked(
    tx,
    1,
    addresses,
    `INSERT INTO accounts (address) VALUES `,
    ` ON CONFLICT (address) DO NOTHING`,
    (address) => [address],
  );

  const ordered = [...rows].sort((a, b) =>
    a.hash < b.hash
      ? -1
      : a.hash > b.hash
        ? 1
        : a.address < b.address
          ? -1
          : a.address > b.address
            ? 1
            : 0,
  );
  const perStatement = Math.max(1, Math.floor(60_000 / 3));
  for (let start = 0; start < ordered.length; start += perStatement) {
    const chunk = ordered.slice(start, start + perStatement);
    const params: unknown[] = [issuanceId];
    const tuples = chunk.map((r) => {
      const h = params.push(r.hash);
      const a = params.push(r.address);
      const d = params.push(r.delta.toString());
      return `($${h}, $${a}, $1, $${d})`;
    });
    await tx.query(
      `INSERT INTO balance_deltas (hash, address, issuance_id, delta)
       VALUES ${tuples.join(", ")}
       ON CONFLICT (hash, address, issuance_id) DO UPDATE SET delta = EXCLUDED.delta`,
      params,
    );
  }
}

/** Execute a multi-row INSERT in chunks that stay under Postgres's 65535-param
 * limit (~60000/columns rows per statement). */
async function insertChunked<T>(
  q: Queryable,
  columns: number,
  rows: readonly T[],
  prefix: string,
  suffix: string,
  toParams: (row: T) => unknown[],
): Promise<void> {
  if (rows.length === 0) return;
  const perStatement = Math.max(1, Math.floor(60_000 / columns));
  for (let start = 0; start < rows.length; start += perStatement) {
    const chunk = rows.slice(start, start + perStatement);
    const params: unknown[] = [];
    const groups = chunk.map((row) => {
      const values = toParams(row);
      const placeholders = values.map((_, i) => `$${params.length + i + 1}`);
      params.push(...values);
      return `(${placeholders.join(", ")})`;
    });
    await q.query(prefix + groups.join(", ") + suffix, params);
  }
}
