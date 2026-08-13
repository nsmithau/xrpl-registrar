import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PgliteDatabase } from "../../src/db/pglite.js";
import { runMigrations } from "../../src/db/migrate.js";

describe("runMigrations", () => {
  let db: PgliteDatabase;

  beforeEach(async () => {
    db = await PgliteDatabase.open(); // in-memory
  });

  afterEach(async () => {
    await db.close();
  });

  it("applies pending migrations once and is idempotent", async () => {
    expect(await runMigrations(db)).toBe(2);
    expect(await runMigrations(db)).toBe(0);

    const { rows } = await db.query<{ id: number | string; name: string }>(
      "SELECT id, name FROM schema_migrations ORDER BY id",
    );
    expect(rows.map((r) => Number(r.id))).toEqual([1, 2]);
    expect(rows.map((r) => r.name)).toEqual(["core_schema", "ledgers"]);
  });

  it("creates the core tables", async () => {
    await runMigrations(db);
    const { rows } = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' ORDER BY table_name`,
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
