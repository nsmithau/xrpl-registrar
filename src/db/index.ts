import type { Database } from "./database.js";
import { runMigrations } from "./migrate.js";
import { PgliteDatabase, type PgliteOptions } from "./pglite.js";
import { PostgresDatabase, type PostgresOptions } from "./postgres.js";

export type { Database, Queryable, QueryResult, Row } from "./database.js";
export { PgliteDatabase, type PgliteOptions } from "./pglite.js";
export { PostgresDatabase, type PostgresOptions } from "./postgres.js";
export { runMigrations } from "./migrate.js";
export { MIGRATIONS, type Migration } from "./migrations.js";
export {
  IssuanceRepository,
  type NewIssuance,
  type NewMptIssuance,
  type NewIouIssuance,
  type IssuanceRecord,
} from "./repositories/issuances.js";
export { TransactionRepository, type IngestTransaction } from "./repositories/transactions.js";
export { AccountRepository, type AccountIssuanceRow } from "./repositories/accounts.js";
export { insertTransactionRows, insertTransactionRowsMany } from "./repositories/transactions.js";
export {
  BackfillJobRepository,
  checkpointJob,
  completeJob,
  type BackfillJob,
  type BackfillStatus,
} from "./repositories/backfillJobs.js";
export { LedgerTimeRepository, type LedgerTime } from "./repositories/ledgers.js";

/**
 * Which engine backs the archive. PGlite is the default and stays the default
 * (ADR-010): a single-issuer self-hosted deployment should not have to run a
 * database server. `engine` is optional so the PGlite spelling is unchanged —
 * `openArchiveDatabase()` and `openArchiveDatabase({ dataDir })` mean exactly
 * what they always did.
 */
export type ArchiveDatabaseOptions =
  | (PgliteOptions & { readonly engine?: "pglite" })
  | (PostgresOptions & { readonly engine: "postgres" });

/**
 * Open the archive database and bring it up to the latest schema. The single
 * entry point callers should use, and the only place the engine is chosen —
 * the repositories never learn which one they got.
 */
export async function openArchiveDatabase(options: ArchiveDatabaseOptions = {}): Promise<Database> {
  const db =
    options.engine === "postgres"
      ? PostgresDatabase.open(options)
      : await PgliteDatabase.open(options);
  await runMigrations(db);
  return db;
}
