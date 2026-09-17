import type { Database } from "./database.js";
import { MIGRATIONS, type Migration } from "./migrations.js";

/**
 * Apply any pending migrations, each in its own transaction, recording applied
 * ids in `schema_migrations`. Idempotent: a second run applies nothing.
 * Returns the number of migrations applied this call.
 *
 * Held under the engine's cross-process migration lock where it has one. On a
 * networked Postgres nothing stops two instances of this service starting at
 * the same moment, and the read-then-apply below is not atomic: both would see
 * the same pending set, and the loser would either duplicate-key on
 * `schema_migrations` or race the other's DDL. Serialising the whole
 * read-and-apply — including the `CREATE TABLE IF NOT EXISTS` that bootstraps
 * the ledger itself — makes a simultaneous start indistinguishable from a
 * sequential one. The in-process engine has a single writer and no lock, so
 * the body simply runs directly.
 */
export async function runMigrations(
  db: Database,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<number> {
  return db.withMigrationLock
    ? db.withMigrationLock(() => applyMigrations(db, migrations))
    : applyMigrations(db, migrations);
}

async function applyMigrations(db: Database, migrations: readonly Migration[]): Promise<number> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         BIGINT PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  const { rows } = await db.query<{ id: number | string }>("SELECT id FROM schema_migrations");
  const applied = new Set(rows.map((r) => Number(r.id)));

  const pending = [...migrations].sort((a, b) => a.id - b.id).filter((m) => !applied.has(m.id));

  for (const migration of pending) {
    await db.transaction(async (tx) => {
      await tx.exec(migration.sql);
      await tx.query("INSERT INTO schema_migrations (id, name) VALUES ($1, $2)", [
        migration.id,
        migration.name,
      ]);
    });
  }

  return pending.length;
}
