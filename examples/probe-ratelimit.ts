/**
 * Rate-limit probe — the measurements behind ADR-015 (governor defaults) and
 * ADR-016 (HTTP paging).
 *
 * Measures how public Clio endpoints shed load, to inform the concurrency
 * governor. Standalone and **bypasses our governor** (we want the endpoint's
 * limits, not ours). Reuses `classifyError` so results map onto the exact load
 * signals the governor reacts to. Probes WebSocket (xrpl.js) and HTTP JSON-RPC.
 *
 * SAFETY — public clusters are shared ("not for sustained/business use").
 * The probe ramps gently, caps the peak, pauses between steps, and aborts a ramp
 * once an endpoint starts shedding. Default target is TESTNET; a mainnet target
 * is opt-in and must be supplied explicitly (PROBE_MAINNET_WS / PROBE_MAINNET_HTTP)
 * — point it at a full-history Clio you are entitled to load-test. Run off-peak
 * and brief the operator before heavy runs. This script is NOT run automatically
 * — invoke it deliberately.
 *
 *   pnpm probe                                   # testnet clio, WS+HTTP, all phases
 *   PROBE_TARGETS=testnet,mainnet PROBE_MAINNET_WS=wss://... PROBE_MAINNET_HTTP=https://... PROBE_ACCOUNT=r... pnpm probe
 *   PROBE_TRANSPORTS=ws PROBE_PHASES=concurrency,rate,recovery pnpm probe
 *   PROBE_METHODS=server_info,account_tx PROBE_MAX_CONCURRENCY=48 pnpm probe
 *
 * Methods (label): server_info (cheap), ledger, ledger_expand (heavy, account-agnostic),
 * account_tx (heavy, the backfill workload — probes PROBE_ACCOUNT, default a testnet account).
 */
import { writeFileSync } from "node:fs";

import { Client } from "xrpl";

import { classifyError } from "../src/index.js";

// --- Targets (xrpl.org public servers) ------------------------------------
interface Target {
  readonly key: string;
  readonly name: string;
  readonly ws: string;
  readonly http: string;
}
const TARGETS: Record<string, Target> = {
  testnet: {
    key: "testnet",
    name: "testnet clio",
    ws: "wss://clio.altnet.rippletest.net:51233/",
    http: "https://clio.altnet.rippletest.net:51234/",
  },
  // No mainnet host is baked in: supply one you are entitled to load-test.
  mainnet: {
    key: "mainnet",
    name: process.env.PROBE_MAINNET_WS ?? "mainnet clio (PROBE_MAINNET_WS/HTTP unset)",
    ws: process.env.PROBE_MAINNET_WS ?? "",
    http: process.env.PROBE_MAINNET_HTTP ?? "",
  },
};

// --- Methods: label → { command, params }. The label is what you pass in
// PROBE_METHODS; `command` is the real Clio command (they differ for the heavy
// ones). `account_tx` binary limit=200 is the backfill workhorse — the knee that
// actually matters. `ledger_expand` is an account-agnostic heavy fallback (use it
// for mainnet unless you set PROBE_ACCOUNT to an active mainnet account).
// The default is a placeholder that does NOT exist on-ledger: set PROBE_ACCOUNT
// to a real, active account (one with lots of history) before probing account_tx,
// or the heavy phase just measures actNotFound round-trips.
const PROBE_ACCOUNT = process.env.PROBE_ACCOUNT ?? "rprPCQEwbJWbGNFCUCMPitVRA2ffajvoW8"; // synthetic placeholder
interface Method {
  readonly command: string;
  readonly params: Record<string, unknown>;
  /** Multi-second latency — skip the open-loop rate ramp (dispatch would just
   * pile up requests faster than they complete). */
  readonly heavy?: boolean;
  /** Follows a `marker` cursor — each request fetches the next page, so the
   * probe walks distinct (mostly-cold) ranges instead of refetching one warm
   * page. Representative of real backfill cost. */
  readonly paginated?: boolean;
}
const METHODS: Record<string, Method> = {
  server_info: { command: "server_info", params: {} },
  ledger: { command: "ledger", params: { ledger_index: "validated" } },
  ledger_expand: {
    command: "ledger",
    params: { ledger_index: "validated", transactions: true, expand: true, binary: true },
    heavy: true,
  },
  account_tx: {
    command: "account_tx",
    params: {
      account: PROBE_ACCOUNT,
      ledger_index_min: -1,
      ledger_index_max: -1,
      binary: true,
      forward: true,
      limit: 200,
    },
    heavy: true,
    paginated: true,
  },
};

// --- Config from env -------------------------------------------------------
const env = process.env;
const csv = (v: string | undefined, fallback: string[]): string[] =>
  v
    ? v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : fallback;
const num = (v: string | undefined, fallback: number): number =>
  v && Number.isFinite(Number(v)) ? Number(v) : fallback;

const CFG = {
  targets: csv(env.PROBE_TARGETS, ["testnet"]),
  transports: csv(env.PROBE_TRANSPORTS, ["ws", "http"]) as ("ws" | "http")[],
  methods: csv(env.PROBE_METHODS, ["server_info", "account_tx"]),
  phases: csv(env.PROBE_PHASES, ["baseline", "concurrency", "rate", "sustained", "recovery"]),
  concurrencyLevels: csv(env.PROBE_CONCURRENCY_LEVELS, ["1", "2", "4", "8", "16", "32"]).map(
    Number,
  ),
  rateLevels: csv(env.PROBE_RATE_LEVELS, ["2", "5", "10", "20", "40"]).map(Number),
  maxConcurrency: num(env.PROBE_MAX_CONCURRENCY, 32),
  maxRate: num(env.PROBE_MAX_RATE, 50),
  burstMs: num(env.PROBE_BURST_MS, 15_000),
  sustainedMs: num(env.PROBE_SUSTAINED_MS, 120_000),
  cooldownMs: num(env.PROBE_COOLDOWN_MS, 5_000),
  recoveryMaxMs: num(env.PROBE_RECOVERY_MAX_MS, 120_000),
  abortErrorRate: num(env.PROBE_ABORT_ERROR_RATE, 0.5),
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const nowMs = (): number => Date.now();

// --- Per-request outcome ----------------------------------------------------
interface Outcome {
  readonly ok: boolean;
  readonly latencyMs: number;
  /** classifyError code, or an HTTP_<status> synthetic code. */
  readonly code?: string;
  readonly retryable?: boolean;
  readonly httpStatus?: number;
  readonly retryAfter?: string;
  /** For paginated methods: the `marker` to pass to the next request (undefined
   * at the end of the account's history — the caller restarts from the top). */
  readonly nextCursor?: unknown;
}

interface Transport {
  readonly kind: "ws" | "http";
  send(method: string, cursor?: unknown): Promise<Outcome>;
  disconnects(): number;
  close(): Promise<void>;
}

// --- WebSocket transport (xrpl.js) -----------------------------------------
async function wsTransport(target: Target): Promise<Transport> {
  const client = new Client(target.ws, { connectionTimeout: 20_000 });
  let disconnects = 0;
  client.on("disconnected", () => {
    disconnects += 1;
  });
  await client.connect();

  return {
    kind: "ws",
    async send(method, cursor) {
      const started = nowMs();
      try {
        if (!client.isConnected()) await client.connect();
        const m = METHODS[method]!;
        const req = {
          command: m.command,
          api_version: 2,
          ...m.params,
          ...(m.paginated && cursor !== undefined ? { marker: cursor } : {}),
        };
        const resp = await client.request(req as Parameters<Client["request"]>[0]);
        const nextCursor = m.paginated
          ? (resp as { result?: { marker?: unknown } }).result?.marker
          : undefined;
        return { ok: true, latencyMs: nowMs() - started, nextCursor };
      } catch (err) {
        const { code, retryable } = classifyError(err);
        return { ok: false, latencyMs: nowMs() - started, code: code ?? "unknown", retryable };
      }
    },
    disconnects: () => disconnects,
    close: async () => {
      if (client.isConnected()) await client.disconnect();
    },
  };
}

// --- HTTP JSON-RPC transport (fetch) ---------------------------------------
function httpTransport(target: Target): Transport {
  return {
    kind: "http",
    async send(method, cursor) {
      const started = nowMs();
      const m = METHODS[method]!;
      const params = {
        api_version: 2,
        ...m.params,
        ...(m.paginated && cursor !== undefined ? { marker: cursor } : {}),
      };
      const body = JSON.stringify({ method: m.command, params: [params] });
      try {
        const res = await fetch(target.http, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        });
        const latencyMs = nowMs() - started;
        const retryAfter = res.headers.get("retry-after") ?? undefined;
        // 429/503/500 are load/availability signals; treat as retryable.
        if (res.status === 429 || res.status === 503 || res.status === 500) {
          return {
            ok: false,
            latencyMs,
            code: `HTTP_${res.status}`,
            retryable: true,
            httpStatus: res.status,
            ...(retryAfter ? { retryAfter } : {}),
          };
        }
        if (!res.ok) {
          return {
            ok: false,
            latencyMs,
            code: `HTTP_${res.status}`,
            retryable: false,
            httpStatus: res.status,
          };
        }
        // A JSON-RPC-level error (e.g. slowDown) rides inside result.error.
        const parsed: unknown = await res.json();
        const result = (parsed as { result?: { error?: unknown; marker?: unknown } }).result;
        const errCode = typeof result?.error === "string" ? result.error : undefined;
        if (errCode) {
          const { retryable } = classifyError({ data: { error: errCode } });
          return { ok: false, latencyMs, code: errCode, retryable, httpStatus: res.status };
        }
        return {
          ok: true,
          latencyMs,
          httpStatus: res.status,
          nextCursor: m.paginated ? result?.marker : undefined,
        };
      } catch (err) {
        const { code, retryable } = classifyError(err);
        return { ok: false, latencyMs: nowMs() - started, code: code ?? "fetch_failed", retryable };
      }
    },
    disconnects: () => 0,
    close: async () => {},
  };
}

// --- Metrics ----------------------------------------------------------------
interface RunResult {
  target: string;
  transport: "ws" | "http";
  method: string;
  mode: "concurrency" | "rate" | "recovery";
  level: number;
  durationMs: number;
  sent: number;
  ok: number;
  errorRate: number;
  throughputPerSec: number;
  latency: { p50: number; p95: number; p99: number; max: number };
  errorsByCode: Record<string, number>;
  httpStatuses: Record<string, number>;
  retryAfterSeen: string | null;
  disconnects: number;
  firstErrorAtMs: number | null;
  /** Recovery phase only: ms from end-of-drive to a 3-success streak, or null
   * if it never recovered within the window. */
  recoveryMs?: number | null;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

function summarize(
  base: Pick<RunResult, "target" | "transport" | "method" | "mode" | "level" | "durationMs">,
  outcomes: Outcome[],
  startedAt: number,
  disconnects: number,
): RunResult {
  const latencies = outcomes.map((o) => o.latencyMs).sort((a, b) => a - b);
  const errorsByCode: Record<string, number> = {};
  const httpStatuses: Record<string, number> = {};
  let ok = 0;
  let firstErrorAtMs: number | null = null;
  let retryAfterSeen: string | null = null;
  let elapsed = 0;
  for (const o of outcomes) {
    elapsed += o.latencyMs;
    if (o.ok) ok += 1;
    else {
      errorsByCode[o.code ?? "unknown"] = (errorsByCode[o.code ?? "unknown"] ?? 0) + 1;
      if (firstErrorAtMs === null) firstErrorAtMs = elapsed;
    }
    if (o.httpStatus)
      httpStatuses[String(o.httpStatus)] = (httpStatuses[String(o.httpStatus)] ?? 0) + 1;
    if (o.retryAfter && retryAfterSeen === null) retryAfterSeen = o.retryAfter;
  }
  const durationMs = nowMs() - startedAt;
  return {
    ...base,
    durationMs,
    sent: outcomes.length,
    ok,
    errorRate: outcomes.length ? (outcomes.length - ok) / outcomes.length : 0,
    throughputPerSec: durationMs ? (ok / durationMs) * 1000 : 0,
    latency: {
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
      max: latencies[latencies.length - 1] ?? 0,
    },
    errorsByCode,
    httpStatuses,
    retryAfterSeen,
    disconnects,
    firstErrorAtMs,
  };
}

// --- Load generators --------------------------------------------------------
/** Closed-loop: `concurrency` workers each send→await→repeat for `durationMs`. */
async function runConcurrency(
  t: Transport,
  method: string,
  concurrency: number,
  durationMs: number,
): Promise<Outcome[]> {
  const deadline = nowMs() + durationMs;
  const outcomes: Outcome[] = [];
  // Each worker walks its own marker chain for paginated methods, so the fleet
  // covers distinct (mostly-cold) pages rather than refetching one warm page.
  const worker = async (): Promise<void> => {
    let cursor: unknown = undefined;
    while (nowMs() < deadline) {
      const o = await t.send(method, cursor);
      outcomes.push(o);
      cursor = o.nextCursor; // undefined ⇒ non-paginated, or end of history: restart from the top
      // If a request fails instantly (broken socket → synchronous throw), don't
      // busy-loop hammering local failures — pause so the step stays meaningful.
      if (!o.ok && o.latencyMs < 10) await sleep(50);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return outcomes;
}

/** Open-loop: dispatch at `ratePerSec` regardless of completion, capped in-flight. */
async function runRate(
  t: Transport,
  method: string,
  ratePerSec: number,
  durationMs: number,
): Promise<Outcome[]> {
  const outcomes: Outcome[] = [];
  const intervalMs = 1000 / ratePerSec;
  const maxInFlight = Math.max(8, ratePerSec * 4); // backstop against unbounded pile-up
  let inFlight = 0;
  const deadline = nowMs() + durationMs;
  while (nowMs() < deadline) {
    if (inFlight < maxInFlight) {
      inFlight += 1;
      void t.send(method).then((o) => {
        outcomes.push(o);
        inFlight -= 1;
      });
    }
    await sleep(intervalMs);
  }
  // Drain outstanding requests.
  const drainUntil = nowMs() + 30_000;
  while (inFlight > 0 && nowMs() < drainUntil) await sleep(50);
  return outcomes;
}

// --- Reporting --------------------------------------------------------------
const results: RunResult[] = [];
function record(r: RunResult): void {
  results.push(r);
  const codes =
    Object.entries(r.errorsByCode)
      .map(([c, n]) => `${c}:${n}`)
      .join(" ") || "-";
  console.log(
    `[${r.target}/${r.transport}/${r.method}] ${r.mode}=${r.level} ` +
      `sent=${r.sent} ok=${r.ok} err=${(r.errorRate * 100).toFixed(0)}% ` +
      `tput=${r.throughputPerSec.toFixed(1)}/s p50=${r.latency.p50}ms p95=${r.latency.p95}ms ` +
      `disc=${r.disconnects} codes=[${codes}]` +
      (r.retryAfterSeen ? ` retry-after=${r.retryAfterSeen}` : ""),
  );
}

// --- Phases -----------------------------------------------------------------
async function phaseBaseline(t: Transport, target: string, method: string): Promise<void> {
  const outcomes: Outcome[] = [];
  const started = nowMs();
  const d0 = t.disconnects();
  for (let i = 0; i < 10; i += 1) outcomes.push(await t.send(method));
  record(
    summarize(
      { target, transport: t.kind, method, mode: "concurrency", level: 1, durationMs: 0 },
      outcomes,
      started,
      t.disconnects() - d0,
    ),
  );
}

async function phaseConcurrency(
  t: Transport,
  target: string,
  method: string,
): Promise<number | null> {
  let knee: number | null = null;
  for (const c of CFG.concurrencyLevels) {
    if (c > CFG.maxConcurrency) break;
    const started = nowMs();
    const d0 = t.disconnects();
    const outcomes = await runConcurrency(t, method, c, CFG.burstMs);
    const r = summarize(
      { target, transport: t.kind, method, mode: "concurrency", level: c, durationMs: 0 },
      outcomes,
      started,
      t.disconnects() - d0,
    );
    record(r);
    if (r.errorRate >= CFG.abortErrorRate) {
      knee = c;
      console.log(
        `  ↳ onset at concurrency=${c} (${(r.errorRate * 100).toFixed(0)}% errors) — stopping ramp`,
      );
      break;
    }
    await sleep(CFG.cooldownMs);
  }
  return knee;
}

async function phaseRate(t: Transport, target: string, method: string): Promise<number | null> {
  if (METHODS[method]!.heavy) {
    console.log(
      `  ↳ skipping rate ramp for heavy method '${method}' — multi-second latency makes open-loop rate meaningless (use the concurrency ramp)`,
    );
    return null;
  }
  let knee: number | null = null;
  for (const rate of CFG.rateLevels) {
    if (rate > CFG.maxRate) break;
    const started = nowMs();
    const d0 = t.disconnects();
    const outcomes = await runRate(t, method, rate, CFG.burstMs);
    const r = summarize(
      { target, transport: t.kind, method, mode: "rate", level: rate, durationMs: 0 },
      outcomes,
      started,
      t.disconnects() - d0,
    );
    record(r);
    if (r.errorRate >= CFG.abortErrorRate) {
      knee = rate;
      console.log(
        `  ↳ onset at rate=${rate}/s (${(r.errorRate * 100).toFixed(0)}% errors) — stopping ramp`,
      );
      break;
    }
    await sleep(CFG.cooldownMs);
  }
  return knee;
}

async function phaseSustained(
  t: Transport,
  target: string,
  method: string,
  kneeConcurrency: number | null,
): Promise<void> {
  // Hold just below the concurrency knee (or a safe default) to expose rolling-window quotas.
  const level = Math.max(1, kneeConcurrency ? Math.floor(kneeConcurrency * 0.6) : 4);
  const started = nowMs();
  const d0 = t.disconnects();
  const outcomes = await runConcurrency(t, method, level, CFG.sustainedMs);
  record(
    summarize(
      { target, transport: t.kind, method, mode: "concurrency", level, durationMs: 0 },
      outcomes,
      started,
      t.disconnects() - d0,
    ),
  );
}

async function phaseRecovery(
  t: Transport,
  target: string,
  method: string,
  kneeConcurrency: number | null,
): Promise<void> {
  // Drive into throttle, then probe single requests until a success streak returns.
  const driveLevel = Math.min(CFG.maxConcurrency, (kneeConcurrency ?? 16) * 2);
  const d0 = t.disconnects();
  await runConcurrency(t, method, driveLevel, CFG.burstMs);
  const startedRecovery = nowMs();
  const probe: Outcome[] = [];
  let streak = 0;
  let recoveryMs: number | null = null;
  while (nowMs() - startedRecovery < CFG.recoveryMaxMs) {
    const o = await t.send(method);
    probe.push(o);
    streak = o.ok ? streak + 1 : 0;
    if (streak >= 3) {
      recoveryMs = nowMs() - startedRecovery;
      break;
    }
    await sleep(1_000);
  }
  record({
    ...summarize(
      { target, transport: t.kind, method, mode: "recovery", level: driveLevel, durationMs: 0 },
      probe,
      startedRecovery,
      t.disconnects() - d0,
    ),
    recoveryMs,
  });
  console.log(
    `[${target}/${t.kind}/${method}] recovery: ${recoveryMs === null ? `>${CFG.recoveryMaxMs}ms (not recovered)` : `${recoveryMs}ms`} after driving concurrency=${driveLevel}`,
  );
}

// --- Main -------------------------------------------------------------------
async function main(): Promise<void> {
  const unknown = CFG.methods.filter((m) => !METHODS[m]);
  if (unknown.length) {
    console.error(
      `unknown method(s): ${unknown.join(", ")} (known: ${Object.keys(METHODS).join(", ")})`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `Rate-limit probe — targets=${CFG.targets.join(",")} transports=${CFG.transports.join(",")} methods=${CFG.methods.join(",")} phases=${CFG.phases.join(",")}`,
  );
  if (CFG.methods.includes("account_tx")) console.log(`account_tx probes account ${PROBE_ACCOUNT}`);
  if (CFG.targets.includes("mainnet")) {
    if (!TARGETS["mainnet"]!.ws || !TARGETS["mainnet"]!.http) {
      console.error(
        "mainnet target requires PROBE_MAINNET_WS and PROBE_MAINNET_HTTP (a full-history Clio you are entitled to load-test).",
      );
      process.exitCode = 1;
      return;
    }
    console.log("⚠️  mainnet clusters are shared — run off-peak and keep the peak modest.");
    if (CFG.methods.includes("account_tx") && !process.env.PROBE_ACCOUNT) {
      console.log(
        "⚠️  account_tx uses the testnet default account — set PROBE_ACCOUNT to an active mainnet account.",
      );
    }
  }

  for (const targetKey of CFG.targets) {
    const target = TARGETS[targetKey];
    if (!target) {
      console.error(`unknown target '${targetKey}' (known: ${Object.keys(TARGETS).join(", ")})`);
      continue;
    }
    for (const transport of CFG.transports) {
      const t = transport === "ws" ? await wsTransport(target) : httpTransport(target);
      try {
        for (const method of CFG.methods) {
          if (CFG.phases.includes("baseline")) await phaseBaseline(t, target.name, method);
          const knee = CFG.phases.includes("concurrency")
            ? await phaseConcurrency(t, target.name, method)
            : null;
          if (CFG.phases.includes("rate")) await phaseRate(t, target.name, method);
          if (CFG.phases.includes("sustained")) await phaseSustained(t, target.name, method, knee);
          if (CFG.phases.includes("recovery")) await phaseRecovery(t, target.name, method, knee);
          await sleep(CFG.cooldownMs);
        }
      } finally {
        await t.close();
      }
    }
  }

  const outFile = `probe-results-${CFG.targets.join("-")}-${nowMs()}.json`;
  writeFileSync(outFile, JSON.stringify({ config: CFG, results }, null, 2));
  console.log(`\nWrote ${results.length} runs to ${outFile}`);
  console.log(
    "Suggested maxConcurrent ≈ 0.6 × the lowest concurrency onset across the heavy method; see the plan for the full mapping.",
  );
}

main().catch((err: unknown) => {
  console.error("probe failed:", err);
  process.exitCode = 1;
});
