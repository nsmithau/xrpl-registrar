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
  decodeMptIssuer,
  deltaDeriver,
  discover,
  holdersInMetaBlob,
  ingestIssuance,
  loadConfig,
  openArchiveDatabase,
  trackedIssuance,
  type TrackedIssuance,
} from "../src/index.js";

const MPT = (process.env.MPT_ISSUANCE_ID ?? "0128C74F0A3198D6E71DE4A6F39C3AD08BD1215358949AE1").toUpperCase();
const PORT = Number(process.env.PORT ?? 51234);
// Safety-net full re-scan interval (0 disables). Streaming discovery is primary;
// this only backstops holders missed during a tail gap. Default 1 hour.
const REDISCOVERY_INTERVAL_MS = Number(process.env.REDISCOVERY_INTERVAL_MS ?? 60 * 60 * 1000);

const config = loadConfig();
// Tracks in-flight backfill/discovery so the dashboard can show live indicators.
const activity = new ActivityRegistry();
const { client } = createClioClient(config);
const db = await openArchiveDatabase(config.db.dataDir !== undefined ? { dataDir: config.db.dataDir } : {});
await client.connect();

// Issuances whose per-transaction deltas the backfill, tail, and gap heal derive
// as transactions land — refreshed whenever an issuance is registered, so
// balance_deltas stays current without a periodic full re-derivation.
let tracked: TrackedIssuance[] = [];
const refreshTracked = async (): Promise<void> => {
  tracked = (await new IssuanceRepository(db).list()).map(trackedIssuance);
};
const deriveDeltas = deltaDeriver(() => tracked);

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
  const worker = new BackfillWorker({ client, db, deriveDeltas: deltaDeriver([trackedIssuance(issuance)]) });
  await worker.enqueue(issuance.id, res.accounts.map((a) => a.address), from);
  const { processed } = await activity.track("backfill", `backfilling ${MPT}`, () =>
    worker.runIssuance(issuance.id),
  );
  console.log(`Discovered ${res.accounts.length} account(s), backfilled ${processed} job(s).`);
} else {
  console.log(`MPT ${MPT} already in archive; serving existing data.`);
}

// The tail and gap heal derive deltas for whatever issuances are tracked now.
await refreshTracked();

const api = new ArchiveApi({ db, forwarder: new ClioForwarder(client) });
const server = new ArchiveServer({ api, port: PORT, host: "127.0.0.1", logger: consoleLogger });
const bound = await server.start();

let tail: LiveTail | undefined;
let tailSource: XrplTailSource | undefined;

// The WebSocket subscribes to holders *and* each issuance's issuer: new-holder-
// forming transactions (opt-ins, issue/redeem) route through the issuer, so
// subscribing to it lets the tail discover new holders from the stream rather
// than a periodic full re-scan.
function issuerAddresses(list: readonly TrackedIssuance[]): string[] {
  const out = new Set<string>();
  for (const i of list) {
    if (i.kind === "mpt" && i.mptIssuanceId) out.add(decodeMptIssuer(i.mptIssuanceId));
    else if (i.kind === "iou" && i.issuer) out.add(i.issuer);
  }
  return [...out];
}
async function subscriptionSet(): Promise<string[]> {
  const rows = await db.query<{ address: string }>("SELECT address FROM accounts ORDER BY address");
  const set = new Set(rows.rows.map((r) => r.address));
  for (const issuer of issuerAddresses(tracked)) set.add(issuer);
  return [...set];
}

// Streaming discovery: when the tail sees a holder of a tracked issuance that is
// not yet in scope, record it, backfill its history, and extend the subscription
// — so brand-new holders are picked up live, without a periodic full re-scan.
const inScope = new Set<string>(); // `${issuanceId}|${address}`
const pendingHolders = new Set<string>();
async function seedInScope(): Promise<void> {
  const rows = await db.query<{ issuance_id: number | string; address: string }>(
    "SELECT issuance_id, address FROM account_issuance",
  );
  inScope.clear();
  for (const r of rows.rows) inScope.add(`${Number(r.issuance_id)}|${r.address}`);
}
async function trackNewHolder(issuanceId: number, holder: string): Promise<void> {
  await new AccountRepository(db).recordDiscovered(issuanceId, [
    { address: holder, discoveredVia: "stream", firstAcquisitionLedger: null },
  ]);
  inScope.add(`${issuanceId}|${holder}`);
  const worker = new BackfillWorker({ client, db, deriveDeltas });
  await worker.enqueue(issuanceId, [holder], 0);
  await activity.track("backfill", `new holder ${holder}`, () => worker.runIssuance(issuanceId));
  if (tailSource) await tailSource.setAccounts(await subscriptionSet());
  consoleLogger.info("new holder tracked from stream", { issuanceId, holder });
}
function onStreamTransaction(metaBlob: Uint8Array): void {
  for (const { issuanceId, holder } of holdersInMetaBlob(metaBlob, tracked)) {
    const key = `${issuanceId}|${holder}`;
    if (inScope.has(key) || pendingHolders.has(key)) continue;
    pendingHolders.add(key);
    void trackNewHolder(issuanceId, holder)
      .catch((err: unknown) => consoleLogger.error("track new holder failed", { holder, error: String(err) }))
      .finally(() => pendingHolders.delete(key));
  }
}
await seedInScope();

// Live tail: keep the archive current, anchoring the gap tracker at the backfill
// high-water so a restart only heals the small recent gap.
const subs = await subscriptionSet();
if (subs.length > 0) {
  // Anchor at the latest ledger observed by either backfill (coverage) or a
  // prior tail run (ledgers), so a restart only heals the small recent gap.
  const cov = await db.query<{ hi: number | string | null }>("SELECT max(to_ledger) AS hi FROM coverage");
  const led = await db.query<{ hi: number | string | null }>("SELECT max(ledger_index) AS hi FROM ledgers");
  const covHi = cov.rows[0]?.hi != null ? Number(cov.rows[0]!.hi) : 0;
  const ledHi = led.rows[0]?.hi != null ? Number(led.rows[0]!.hi) : 0;
  const highWater = Math.max(covHi, ledHi) || undefined;
  tailSource = new XrplTailSource({ endpoint: config.clio.endpoint, accounts: subs, reader: client });
  tail = new LiveTail({
    db,
    source: tailSource,
    logger: consoleLogger,
    deriveDeltas,
    onTransaction: (ev) => onStreamTransaction(ev.metaBlob),
    ...(highWater !== undefined ? { startLedger: highWater } : {}),
    onGap: async (range) => {
      // Heal against the current subscription set (holders + issuers), which the
      // issuer entry makes cover new-holder activity missed during the gap.
      const healSet = await subscriptionSet();
      await activity.track(
        "backfill",
        `healing ${range.fromLedger}–${range.toLedger}`,
        () => backfillGap(client, db, healSet, range, consoleLogger, deriveDeltas),
      );
    },
  });
  void tail.run();
  console.log(`Live tail    : ${subs.length} account(s) (holders + issuers), healing from ledger ${highWater ?? "(none)"}`);
}

// Periodic re-discovery is now a *safety net*: the live tail discovers new
// holders from the stream (via the issuer subscription) as they appear, so this
// only backstops anything a tail gap might have missed. It re-runs the full
// scan, so keep the interval long (or 0 to disable) — streaming is primary.
let rediscoverTimer: NodeJS.Timeout | undefined;
async function rediscover(): Promise<void> {
  const issuances = await new IssuanceRepository(db).list();
  for (const issuance of issuances) {
    if (!issuance.enabled) continue;
    await ingestIssuance(client, db, issuance, consoleLogger, activity);
  }
  await refreshTracked();
  await seedInScope();
  if (tailSource) await tailSource.setAccounts(await subscriptionSet());
}
if (REDISCOVERY_INTERVAL_MS > 0) {
  rediscoverTimer = setInterval(() => {
    void rediscover().catch((err: unknown) =>
      consoleLogger.error("periodic re-discovery failed", { error: String(err) }),
    );
  }, REDISCOVERY_INTERVAL_MS);
  console.log(`Re-discovery : safety-net re-scan every ${Math.round(REDISCOVERY_INTERVAL_MS / 1000)}s (streaming is primary; REDISCOVERY_INTERVAL_MS=0 to disable)`);
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
          // Track the new issuance (for tail delta derivation + streaming
          // discovery), and bring its accounts and issuer into the subscription.
          await refreshTracked();
          await seedInScope();
          if (tailSource) await tailSource.setAccounts(await subscriptionSet());
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
