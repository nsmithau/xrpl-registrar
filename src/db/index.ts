import type { Database } from "./database.js";
import { runMigrations } from "./migrate.js";
import { PgliteDatabase, type PgliteOptions } from "./pglite.js";

export type { Database, Queryable, QueryResult, Row } from "./database.js";
export { PgliteDatabase, type PgliteOptions } from "./pglite.js";
export { runMigrations } from "./migrate.js";
export { MIGRATIONS, type Migration } from "./migrations.js";
export {
  IssuanceRepository,
  type NewIssuance,
  type NewMptIssuance,
  type NewIouIssuance,
  type IssuanceRecord,
  type DiscoveryStrategy,
} from "./repositories/issuances.js";
export {
  TransactionRepository,
  type IngestTransaction,
} from "./repositories/transactions.js";
export {
  AccountRepository,
  type AccountIssuanceRow,
} from "./repositories/accounts.js";
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
 * Open the archive database (in-process PGlite) and bring it up to the latest
 * schema. The single entry point callers should use.
 */
export async function openArchiveDatabase(options: PgliteOptions = {}): Promise<Database> {
  const db = await PgliteDatabase.open(options);
  await runMigrations(db);
  return db;
}
