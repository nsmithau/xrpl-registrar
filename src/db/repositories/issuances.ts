import type { Queryable, Row } from "../database.js";

export type DiscoveryStrategy = "auto" | "authorization" | "trustline" | "traversal";

export interface NewMptIssuance {
  readonly kind: "mpt";
  readonly mptIssuanceId: string;
  readonly requiresAuth?: boolean;
  readonly discoveryStrategy?: DiscoveryStrategy;
  readonly backfillFromLedger?: number;
  readonly enabled?: boolean;
}

export interface NewIouIssuance {
  readonly kind: "iou";
  readonly currency: string;
  readonly issuerAccount: string;
  readonly discoveryStrategy?: DiscoveryStrategy;
  readonly backfillFromLedger?: number;
  readonly enabled?: boolean;
}

export type NewIssuance = NewMptIssuance | NewIouIssuance;

export interface IssuanceRecord {
  readonly id: number;
  readonly kind: "mpt" | "iou";
  readonly mptIssuanceId: string | null;
  readonly currency: string | null;
  readonly issuerAccount: string | null;
  readonly discoveryStrategy: string;
  readonly requiresAuth: boolean | null;
  readonly backfillFromLedger: number;
  readonly enabled: boolean;
  readonly createdAt: string;
}

interface IssuanceRow extends Row {
  id: number | string;
  kind: "mpt" | "iou";
  mpt_issuance_id: string | null;
  currency: string | null;
  issuer_account: string | null;
  discovery_strategy: string;
  requires_auth: boolean | null;
  backfill_from_ledger: number | string;
  enabled: boolean;
  created_at: unknown;
}

function toIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function mapRow(row: IssuanceRow): IssuanceRecord {
  return {
    id: Number(row.id),
    kind: row.kind,
    mptIssuanceId: row.mpt_issuance_id,
    currency: row.currency,
    issuerAccount: row.issuer_account,
    discoveryStrategy: row.discovery_strategy,
    requiresAuth: row.requires_auth,
    backfillFromLedger: Number(row.backfill_from_ledger),
    enabled: row.enabled,
    createdAt: toIso(row.created_at),
  };
}

const COLUMNS = `id, kind, mpt_issuance_id, currency, issuer_account,
  discovery_strategy, requires_auth, backfill_from_ledger, enabled, created_at`;

/** CRUD for configured issuances — the unit of configuration. */
export class IssuanceRepository {
  readonly #db: Queryable;

  constructor(db: Queryable) {
    this.#db = db;
  }

  async create(input: NewIssuance): Promise<IssuanceRecord> {
    const common = {
      discoveryStrategy: input.discoveryStrategy ?? "auto",
      backfillFromLedger: input.backfillFromLedger ?? 0,
      enabled: input.enabled ?? true,
    };

    const params =
      input.kind === "mpt"
        ? [
            "mpt",
            input.mptIssuanceId,
            null,
            null,
            common.discoveryStrategy,
            input.requiresAuth ?? null,
            common.backfillFromLedger,
            common.enabled,
          ]
        : [
            "iou",
            null,
            input.currency,
            input.issuerAccount,
            common.discoveryStrategy,
            null,
            common.backfillFromLedger,
            common.enabled,
          ];

    const { rows } = await this.#db.query<IssuanceRow>(
      `INSERT INTO issuances
         (kind, mpt_issuance_id, currency, issuer_account,
          discovery_strategy, requires_auth, backfill_from_ledger, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${COLUMNS}`,
      params,
    );
    return mapRow(rows[0]!);
  }

  async getById(id: number): Promise<IssuanceRecord | null> {
    const { rows } = await this.#db.query<IssuanceRow>(
      `SELECT ${COLUMNS} FROM issuances WHERE id = $1`,
      [id],
    );
    return rows.length > 0 ? mapRow(rows[0]!) : null;
  }

  async list(): Promise<IssuanceRecord[]> {
    const { rows } = await this.#db.query<IssuanceRow>(
      `SELECT ${COLUMNS} FROM issuances ORDER BY id`,
    );
    return rows.map(mapRow);
  }

  async setEnabled(id: number, enabled: boolean): Promise<void> {
    await this.#db.query("UPDATE issuances SET enabled = $2 WHERE id = $1", [id, enabled]);
  }
}
