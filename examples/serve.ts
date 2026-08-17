/**
 * Run the archive as a Clio-compatible server you can hit with xrpl.js,
 * Postman, or curl. Serves the existing archive over HTTP JSON-RPC and
 * WebSocket and keeps it current; it never auto-ingests — register issuances via
 * the admin API. Node-state methods (e.g. server_info) forward upstream so
 * xrpl.js can connect. The guided testnet tour that ingests a sample issuance is
 * `pnpm demo`.
 *
 *   CLIO_ENDPOINT=wss://<testnet-clio> ADMIN_TOKEN=secret pnpm serve
 *
 * Optional: PORT=<port>, DATABASE_DIR=<dir> (persist).
 */
import {
  ActivityRegistry,
  AdminApi,
  AdminServer,
  ArchiveApi,
  ArchiveServer,
  AccountRepository,
  BackfillJobRepository,
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
  holdersInMeta,
  ingestIssuance,
  issuerOf,
  lazyLedgerTimeResolver,
  loadConfig,
  openArchiveDatabase,
  runIssuerBackfill,
  trackedIssuance,
  type DecodedMeta,
  type TrackedIssuance,
} from "../src/index.js";

const PORT = Number(process.env.PORT ?? 51234);
// Safety-net full re-scan interval (0 disables). Streaming discovery is primary;
// this only backstops holders missed during a tail gap. Default 1 hour.
const REDISCOVERY_INTERVAL_MS = Number(process.env.REDISCOVERY_INTERVAL_MS ?? 60 * 60 * 1000);

// Console logger that renders the high-frequency backfill/heal progress as a
// single in-place counter on a TTY (dropped entirely when piped), while every
// other structured log passes through unchanged.
function withProgressCounter(base: typeof consoleLogger): typeof consoleLogger {
  const tty = process.stderr.isTTY === true;
  let counterOpen = false;
  const endCounter = (): void => {
    if (counterOpen) {
      process.stderr.write("\n");
      counterOpen = false;
    }
  };
  const progress = (message: string, meta?: Record<string, unknown>): boolean => {
    if (message !== "backfill progress" && message !== "gap heal progress") return false;
    if (!tty) return true; // no line-per-1000-tx spam when piped to a file
    const n = Number(meta?.["tx"] ?? meta?.["ingested"] ?? 0);
    const label = message === "gap heal progress" ? "healing" : "backfilling";
    process.stderr.write(`\r  ${label} ${n.toLocaleString()} tx`);
    counterOpen = true;
    return true;
  };
  return {
    info: (message, meta) => {
      if (progress(message, meta)) return;
      endCounter();
      base.info(message, meta);
    },
    warn: (message, meta) => {
      endCounter();
      base.warn(message, meta);
    },
    error: (message, meta) => {
      endCounter();
      base.error(message, meta);
    },
  };
}

const config = loadConfig();
const log = withProgressCounter(consoleLogger);
// Tracks in-flight backfill/discovery so the dashboard can show live indicators.
const activity = new ActivityRegistry();
const { client } = createClioClient(config);
const db = await openArchiveDatabase(config.db.dataDir !== undefined ? { dataDir: config.db.dataDir } : {});
// Startup guard: confirm the upstream is a full-history Clio. A partial-history
// xrpld node or the wrong network would make the archive silently incomplete —
// so surface server_info and warn loudly when it doesn't look like Clio.
async function verifyEndpoint(): Promise<void> {
  try {
    const res = await client.request<{ info?: Record<string, unknown> }>({ command: "server_info" });
    const info = res.result.info ?? {};
    const clio = typeof info["clio_version"] === "string" ? info["clio_version"] : undefined;
    const ledgers = typeof info["complete_ledgers"] === "string" ? info["complete_ledgers"] : "unknown";
    const network = info["network_id"] ?? "?";
    console.log(`  ${clio ? `Clio ${clio}` : "NOT a Clio server"} · ledgers ${ledgers} · network_id ${network}`);
    if (!clio) {
      console.warn(
        `  ⚠  ${config.clio.endpoint} does not report as Clio (no clio_version in server_info).\n` +
          `     It looks like an xrpld node — full history and Clio-only methods (e.g. mpt_holders)\n` +
          `     are not guaranteed, so the archive may be silently incomplete. Point CLIO_ENDPOINT\n` +
          `     at a full-history Clio, and confirm network_id matches the issuances you track.`,
      );
    }
  } catch (err) {
    console.warn(`  ⚠  could not verify the endpoint via server_info: ${String(err)}`);
  }
}

console.log(`Connecting to Clio: ${config.clio.endpoint}`);
await client.connect();
await verifyEndpoint();

// Issuances whose per-transaction deltas the backfill, tail, and gap heal derive
// as transactions land — refreshed whenever an issuance is registered, so
// balance_deltas stays current without a periodic full re-derivation.
let tracked: TrackedIssuance[] = [];
const refreshTracked = async (): Promise<void> => {
  tracked = (await new IssuanceRepository(db).list()).map(trackedIssuance);
};
const deriveDeltas = deltaDeriver(() => tracked);

// serve never auto-populates: it serves whatever is already in the archive and
// keeps it current. Register issuances via the admin API; the guided testnet
// tour that ingests a sample issuance is `pnpm demo`.
console.log("Serving the existing archive; register issuances via the admin API.");

// The tail and gap heal derive deltas for whatever issuances are tracked now.
await refreshTracked();

const api = new ArchiveApi({
  db,
  forwarder: new ClioForwarder(client),
  // Resolve time-based reporting queries lazily against Clio, caching probed
  // close times — no eager per-ledger capture at registration.
  resolveLedgerTime: lazyLedgerTimeResolver(client, db),
});
const server = new ArchiveServer({ api, port: PORT, host: "127.0.0.1", logger: log });
const bound = await server.start();

// Forward-declared: the streaming-discovery closures below reference it before
// it is created; assigned once when the tail starts.
// eslint-disable-next-line prefer-const
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
  log.info("new holder tracked from stream", { issuanceId, holder });
}
function onStreamTransaction(meta: DecodedMeta): void {
  if (!meta) return;
  for (const { issuanceId, holder } of holdersInMeta(meta, tracked)) {
    const key = `${issuanceId}|${holder}`;
    if (inScope.has(key) || pendingHolders.has(key)) continue;
    pendingHolders.add(key);
    void trackNewHolder(issuanceId, holder)
      .catch((err: unknown) => log.error("track new holder failed", { holder, error: String(err) }))
      .finally(() => pendingHolders.delete(key));
  }
}
await seedInScope();

// Live tail: keep the archive current. Started unconditionally — even on an
// empty archive — so issuances registered later via the admin API are picked up
// live (onRegistered calls tailSource.setAccounts to subscribe them); a guard on
// "subs is non-empty" would leave a fresh server with no tail. Anchor the gap
// tracker at the backfill/observed high-water so a restart heals only the small
// recent gap.
const subs = await subscriptionSet();
const cov = await db.query<{ hi: number | string | null }>("SELECT max(to_ledger) AS hi FROM coverage");
const led = await db.query<{ hi: number | string | null }>("SELECT max(ledger_index) AS hi FROM ledgers");
const covHi = cov.rows[0]?.hi != null ? Number(cov.rows[0]!.hi) : 0;
const ledHi = led.rows[0]?.hi != null ? Number(led.rows[0]!.hi) : 0;
const highWater = Math.max(covHi, ledHi) || undefined;
tailSource = new XrplTailSource({ endpoint: config.clio.endpoint, accounts: subs, reader: client });
const tail = new LiveTail({
  db,
  source: tailSource,
  logger: log,
  deriveDeltas,
  onTransaction: (_ev, meta) => onStreamTransaction(meta),
  ...(highWater !== undefined ? { startLedger: highWater } : {}),
  onGap: async (range) => {
    // Heal by sweeping each issuer's account_tx over the gap range: one bounded,
    // paginated call per issuer captures every holder and every issuance on it
    // (Clio indexes MPT/IOU activity, including holder-to-holder payments,
    // against the issuer), instead of a request per gap ledger or per holder.
    const issuers = issuerAddresses(tracked);
    await activity.track("backfill", `healing ${range.fromLedger}–${range.toLedger}`, () =>
      backfillGap(client, db, issuers, range, tracked, {
        logger: log,
        deriveDeltas,
        // Discover holders that first appeared during the gap, same as the tail.
        onEntry: (meta) => onStreamTransaction(meta),
      }),
    );
  },
});
void tail.run();
console.log(`Live tail    : ${subs.length} account(s) (holders + issuers), healing from ledger ${highWater ?? "(none)"}`);

// Resume any interrupted backfill on startup: a prior run may have left pending
// (never reached), running (crashed), or failed (transient upstream) jobs.
// Without this they wait for the next hourly re-discovery; here they finish now,
// in the background, so serve comes up immediately.
async function resumeBackfills(): Promise<void> {
  const jobs = new BackfillJobRepository(db);
  for (const issuance of await new IssuanceRepository(db).list()) {
    if (!issuance.enabled) continue;
    const label = issuance.kind === "mpt" ? issuance.mptIssuanceId : `${issuance.currency}/${issuance.issuerAccount}`;

    // The issuer sweep (kind='issuer'): resume it if a prior run left it
    // pending/running/failed. reclaimStale returns running/failed to pending.
    const issuer = issuerOf(issuance);
    const issuerJob = await jobs.getByAccount(issuance.id, issuer);
    if (issuerJob && issuerJob.status !== "completed") {
      await jobs.reclaimStale(issuance.id);
      const fresh = (await jobs.getByAccount(issuance.id, issuer))!;
      log.info("resuming issuer backfill", { issuanceId: issuance.id, status: issuerJob.status });
      await activity.track("backfill", `resuming ${label ?? issuance.id}`, () =>
        runIssuerBackfill(client, db, trackedIssuance(issuance), fresh, {
          logger: log,
          deriveDeltas: deltaDeriver([trackedIssuance(issuance)]),
        }),
      );
    }

    // Per-holder jobs (kind='account') enqueued by the tail's new-holder path.
    const { rows } = await db.query<{ n: number | string }>(
      "SELECT count(*)::int AS n FROM backfill_job WHERE issuance_id = $1 AND kind = 'account' AND status IN ('pending','running','failed')",
      [issuance.id],
    );
    if (Number(rows[0]?.n ?? 0) > 0) {
      log.info("resuming holder backfills", { issuanceId: issuance.id, outstanding: Number(rows[0]!.n) });
      const worker = new BackfillWorker({ client, db, logger: log, deriveDeltas });
      await activity.track("backfill", `resuming holders ${label ?? issuance.id}`, () => worker.runIssuance(issuance.id));
    }
  }
}
void resumeBackfills().catch((err: unknown) => log.error("resume backfill failed", { error: String(err) }));

// Periodic re-discovery is now a *safety net*: the live tail discovers new
// holders from the stream (via the issuer subscription) as they appear, so this
// only backstops anything a tail gap might have missed. It re-runs the full
// scan, so keep the interval long (or 0 to disable) — streaming is primary.
let rediscoverTimer: NodeJS.Timeout | undefined;
async function rediscover(): Promise<void> {
  const issuances = await new IssuanceRepository(db).list();
  for (const issuance of issuances) {
    if (!issuance.enabled) continue;
    await ingestIssuance(client, db, issuance, log, activity);
  }
  await refreshTracked();
  await seedInScope();
  if (tailSource) await tailSource.setAccounts(await subscriptionSet());
}
if (REDISCOVERY_INTERVAL_MS > 0) {
  rediscoverTimer = setInterval(() => {
    void rediscover().catch((err: unknown) =>
      log.error("periodic re-discovery failed", { error: String(err) }),
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
    `    -d '{"method":"mpt_holders","params":[{"mpt_issuance_id":"<mpt_issuance_id>","api_version":2}]}'`,
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
    logger: log,
    onRegistered: (issuance) => {
      ingestIssuance(client, db, issuance, log, activity)
        .then(async () => {
          // Track the new issuance (for tail delta derivation + streaming
          // discovery), and bring its accounts and issuer into the subscription.
          await refreshTracked();
          await seedInScope();
          if (tailSource) await tailSource.setAccounts(await subscriptionSet());
        })
        .catch((err: unknown) => log.error("background ingest failed", { error: String(err) }));
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
    tail.stop();
    if (tailSource) await tailSource.close();
    await server.stop();
    if (adminServer) await adminServer.stop();
    await client.disconnect();
    await db.close();
    process.exit(0);
  })();
});
