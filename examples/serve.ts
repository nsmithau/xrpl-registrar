/**
 * Run the archive as a Clio-compatible server you can hit with xrpl.js,
 * Postman, or curl.
 *
 * Populates the archive for one MPT issuance (discovery + backfill), then
 * serves it over HTTP JSON-RPC and WebSocket. Node-state methods (e.g.
 * server_info) forward upstream so xrpl.js can connect.
 *
 *   CLIO_ENDPOINT=wss://<testnet-clio> pnpm serve
 *
 * Optional: MPT_ISSUANCE_ID=<hex>, PORT=<port>, DATABASE_DIR=<dir> (persist).
 */
import {
  ArchiveApi,
  ArchiveServer,
  AccountRepository,
  BackfillWorker,
  ClioForwarder,
  IssuanceRepository,
  consoleLogger,
  createClioClient,
  discover,
  loadConfig,
  openArchiveDatabase,
} from "../src/index.js";

const MPT = (process.env.MPT_ISSUANCE_ID ?? "0128C74F0A3198D6E71DE4A6F39C3AD08BD1215358949AE1").toUpperCase();
const PORT = Number(process.env.PORT ?? 51234);

const config = loadConfig();
const { client } = createClioClient(config);
const db = await openArchiveDatabase(config.db.dataDir !== undefined ? { dataDir: config.db.dataDir } : {});
await client.connect();

// Populate the archive for the issuance, unless it is already tracked.
const existing = await db.query("SELECT id FROM issuances WHERE mpt_issuance_id = $1", [MPT]);
if (existing.rows.length === 0) {
  console.log(`Populating archive for MPT ${MPT}…`);
  const res = await discover(client, { kind: "mpt", mptIssuanceId: MPT, strategy: "authorization" });
  const issuance = await new IssuanceRepository(db).create({ kind: "mpt", mptIssuanceId: MPT });
  await new AccountRepository(db).recordDiscovered(issuance.id, res.accounts);
  const from = Math.min(...res.accounts.map((a) => a.firstAcquisitionLedger ?? 0).filter(Boolean));
  const worker = new BackfillWorker({ client, db });
  await worker.enqueue(issuance.id, res.accounts.map((a) => a.address), from);
  const { processed } = await worker.runIssuance(issuance.id);
  console.log(`Discovered ${res.accounts.length} account(s), backfilled ${processed} job(s).`);
} else {
  console.log(`MPT ${MPT} already in archive; serving existing data.`);
}

const api = new ArchiveApi({ db, forwarder: new ClioForwarder(client) });
const server = new ArchiveServer({ api, port: PORT, host: "127.0.0.1", logger: consoleLogger });
const bound = await server.start();

console.log(`\nArchive serving (Clio-compatible):`);
console.log(`  WebSocket    : ws://127.0.0.1:${bound}`);
console.log(`  HTTP JSON-RPC: http://127.0.0.1:${bound}`);
console.log(`\nExample (HTTP JSON-RPC):`);
console.log(
  `  curl -s http://127.0.0.1:${bound} -H 'content-type: application/json' \\\n` +
    `    -d '{"method":"mpt_holders","params":[{"mpt_issuance_id":"${MPT}","api_version":2}]}'`,
);
console.log(`\nPress Ctrl-C to stop.`);

process.on("SIGINT", () => {
  void (async () => {
    await server.stop();
    await client.disconnect();
    await db.close();
    process.exit(0);
  })();
});
