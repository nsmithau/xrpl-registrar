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
  ActivityRegistry,
  AdminApi,
  AdminServer,
  ArchiveApi,
  ArchiveServer,
  AccountRepository,
  BackfillWorker,
  ClioForwarder,
  IssuanceRepository,
  LiveTail,
  XrplTailSource,
  backfillGap,
  consoleLogger,
  createClioClient,
  discover,
  ingestIssuance,
  loadConfig,
  openArchiveDatabase,
} from "../src/index.js";

const MPT = (process.env.MPT_ISSUANCE_ID ?? "0128C74F0A3198D6E71DE4A6F39C3AD08BD1215358949AE1").toUpperCase();
const PORT = Number(process.env.PORT ?? 51234);
// How often to re-scan tracked issuances for new holders (0 disables).
const REDISCOVERY_INTERVAL_MS = Number(process.env.REDISCOVERY_INTERVAL_MS ?? 15 * 60 * 1000);

const config = loadConfig();
// Tracks in-flight backfill/discovery so the dashboard can show live indicators.
const activity = new ActivityRegistry();
const { client } = createClioClient(config);
const db = await openArchiveDatabase(config.db.dataDir !== undefined ? { dataDir: config.db.dataDir } : {});
await client.connect();

// Populate the archive for the issuance, unless it is already tracked.
const existing = await db.query("SELECT id FROM issuances WHERE mpt_issuance_id = $1", [MPT]);
if (existing.rows.length === 0) {
  console.log(`Populating archive for MPT ${MPT}…`);
  const res = await activity.track("discovery", `discovering ${MPT}`, () =>
    discover(client, { kind: "mpt", mptIssuanceId: MPT, strategy: "authorization" }, { logger: consoleLogger }),
  );
  const issuance = await new IssuanceRepository(db).create({ kind: "mpt", mptIssuanceId: MPT });
  await new AccountRepository(db).recordDiscovered(issuance.id, res.accounts);
  const from = Math.min(...res.accounts.map((a) => a.firstAcquisitionLedger ?? 0).filter(Boolean));
  const worker = new BackfillWorker({ client, db });
  await worker.enqueue(issuance.id, res.accounts.map((a) => a.address), from);
  const { processed } = await activity.track("backfill", `backfilling ${MPT}`, () =>
    worker.runIssuance(issuance.id),
  );
  console.log(`Discovered ${res.accounts.length} account(s), backfilled ${processed} job(s).`);
} else {
  console.log(`MPT ${MPT} already in archive; serving existing data.`);
}

const api = new ArchiveApi({ db, forwarder: new ClioForwarder(client) });
const server = new ArchiveServer({ api, port: PORT, host: "127.0.0.1", logger: consoleLogger });
const bound = await server.start();

// Live tail: keep the archive current. Subscribe to every in-scope account and
// anchor the gap tracker at the backfill high-water, so the gap since backfill
// is healed on the first ledger and new transactions are ingested as they land.
const scopeRows = await db.query<{ address: string }>("SELECT address FROM accounts ORDER BY address");
const scope = scopeRows.rows.map((r) => r.address);
let tail: LiveTail | undefined;
let tailSource: XrplTailSource | undefined;
if (scope.length > 0) {
  // Anchor at the latest ledger observed by either backfill (coverage) or a
  // prior tail run (ledgers), so a restart only heals the small recent gap.
  const cov = await db.query<{ hi: number | string | null }>("SELECT max(to_ledger) AS hi FROM coverage");
  const led = await db.query<{ hi: number | string | null }>("SELECT max(ledger_index) AS hi FROM ledgers");
  const covHi = cov.rows[0]?.hi != null ? Number(cov.rows[0]!.hi) : 0;
  const ledHi = led.rows[0]?.hi != null ? Number(led.rows[0]!.hi) : 0;
  const highWater = Math.max(covHi, ledHi) || undefined;
  tailSource = new XrplTailSource({ endpoint: config.clio.endpoint, accounts: scope, reader: client });
  tail = new LiveTail({
    db,
    source: tailSource,
    logger: consoleLogger,
    ...(highWater !== undefined ? { startLedger: highWater } : {}),
    onGap: async (range) => {
      // Heal against the current in-scope set (re-discovery may have grown it).
      const rows = await db.query<{ address: string }>("SELECT address FROM accounts ORDER BY address");
      await activity.track(
        "backfill",
        `healing ${range.fromLedger}–${range.toLedger}`,
        () => backfillGap(client, db, rows.rows.map((r) => r.address), range, consoleLogger),
      );
    },
  });
  void tail.run();
  console.log(`Live tail    : ${scope.length} account(s), healing from ledger ${highWater ?? "(none)"}`);
}

// Periodic re-discovery: re-scan every tracked issuance for holders that have
// appeared since the last scan, backfill any new accounts, and extend the live
// subscription to cover them — so a long-running server picks up new holders
// without a restart. Reuses the registration pipeline (idempotent throughout).
let rediscoverTimer: NodeJS.Timeout | undefined;
async function rediscover(): Promise<void> {
  const issuances = await new IssuanceRepository(db).list();
  for (const issuance of issuances) {
    if (!issuance.enabled) continue;
    await ingestIssuance(client, db, issuance, consoleLogger, activity);
  }
  if (tailSource) {
    const rows = await db.query<{ address: string }>("SELECT address FROM accounts ORDER BY address");
    await tailSource.setAccounts(rows.rows.map((r) => r.address));
  }
}
if (REDISCOVERY_INTERVAL_MS > 0) {
  rediscoverTimer = setInterval(() => {
    void rediscover().catch((err: unknown) =>
      consoleLogger.error("periodic re-discovery failed", { error: String(err) }),
    );
  }, REDISCOVERY_INTERVAL_MS);
  console.log(`Re-discovery : every ${Math.round(REDISCOVERY_INTERVAL_MS / 1000)}s (set REDISCOVERY_INTERVAL_MS=0 to disable)`);
}

console.log(`\nArchive serving (Clio-compatible):`);
console.log(`  WebSocket    : ws://127.0.0.1:${bound}`);
console.log(`  HTTP JSON-RPC: http://127.0.0.1:${bound}`);
console.log(`\nExample (HTTP JSON-RPC):`);
console.log(
  `  curl -s http://127.0.0.1:${bound} -H 'content-type: application/json' \\\n` +
    `    -d '{"method":"mpt_holders","params":[{"mpt_issuance_id":"${MPT}","api_version":2}]}'`,
);
// Admin port (authenticated), enabled when ADMIN_TOKEN is set. Registering an
// issuance here triggers discovery + backfill + derivation in the background.
let adminServer: AdminServer | undefined;
if (config.admin.token) {
  adminServer = new AdminServer({
    api: new AdminApi(db, activity),
    token: config.admin.token,
    port: config.admin.port,
    host: "127.0.0.1",
    logger: consoleLogger,
    onRegistered: (issuance) => {
      ingestIssuance(client, db, issuance, consoleLogger, activity)
        .then(async () => {
          // Bring the newly-registered issuance's accounts into the live tail.
          if (!tailSource) return;
          const rows = await db.query<{ address: string }>("SELECT address FROM accounts ORDER BY address");
          await tailSource.setAccounts(rows.rows.map((r) => r.address));
        })
        .catch((err: unknown) => consoleLogger.error("background ingest failed", { error: String(err) }));
    },
  });
  const adminBound = await adminServer.start();
  console.log(`  Admin API    : http://127.0.0.1:${adminBound}/admin/issuances (Bearer token)`);
  console.log(`  Dashboard    : http://127.0.0.1:${adminBound}/  (read-only; paste the token)`);
} else {
  console.log(`  Admin API    : disabled (set ADMIN_TOKEN to enable)`);
}

console.log(`\nPress Ctrl-C to stop.`);

process.on("SIGINT", () => {
  void (async () => {
    if (rediscoverTimer) clearInterval(rediscoverTimer);
    tail?.stop();
    if (tailSource) await tailSource.close();
    await server.stop();
    if (adminServer) await adminServer.stop();
    await client.disconnect();
    await db.close();
    process.exit(0);
  })();
});
