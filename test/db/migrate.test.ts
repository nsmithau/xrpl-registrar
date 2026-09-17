import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../../src/db/database.js";
import { runMigrations } from "../../src/db/migrate.js";
import { openUnmigratedTestDatabase } from "../dbHelpers.js";

describe("runMigrations", () => {
  let db: Database;

  beforeEach(async () => {
    // Deliberately unmigrated: these tests watch the runner do the work.
    db = await openUnmigratedTestDatabase();
  });

  afterEach(async () => {
    await db.close();
  });

  it("applies pending migrations once and is idempotent", async () => {
    expect(await runMigrations(db)).toBe(3);
    expect(await runMigrations(db)).toBe(0);

    const { rows } = await db.query<{ id: number | string; name: string }>(
      "SELECT id, name FROM schema_migrations ORDER BY id",
    );
    expect(rows.map((r) => Number(r.id))).toEqual([1, 2, 3]);
    expect(rows.map((r) => r.name)).toEqual(["core_schema", "ledgers", "perf_indexes"]);
  });

  it("creates the perf indexes", async () => {
    await runMigrations(db);
    // `current_schema()`, not a literal 'public': under Postgres each suite
    // migrates into its own schema, so a hardcoded 'public' would look at
    // somebody else's tables — or at nothing at all.
    const { rows } = await db.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()",
    );
    const indexes = rows.map((r) => r.indexname);
    for (const expected of [
      "account_issuance_issuance_idx",
      "balance_deltas_issuance_addr_idx",
      "backfill_job_issuance_status_idx",
    ]) {
      expect(indexes).toContain(expected);
    }
  });

  it("creates the core tables", async () => {
    await runMigrations(db);
    const { rows } = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = current_schema() ORDER BY table_name`,
    );
    const tables = rows.map((r) => r.table_name);
    for (const expected of [
      "accounts",
      "account_issuance",
      "account_transactions",
      "backfill_job",
      "balance_deltas",
      "coverage",
      "issuances",
      "reconciliation_run",
      "transactions",
    ]) {
      expect(tables).toContain(expected);
    }
  });
});
