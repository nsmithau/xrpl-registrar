import type { Database } from "../db/database.js";
import { LedgerTimeRepository } from "../db/repositories/ledgers.js";
import { asRecord, asString } from "../discovery/fields.js";
import type { ClioReader } from "../discovery/types.js";

/** Resolve a timestamp to the archive's ledger in effect at or before it — the
 * highest ledger index whose close time is `<= iso`, or null if none is that
 * old. Used by the time-based reporting methods. */
export type LedgerTimeResolver = (iso: string) => Promise<number | null>;

/** Ensure the given ledgers' close times exist. Fills in whichever are missing. */
export type CloseTimeFiller = (ledgerIndices: readonly number[]) => Promise<void>;

/**
 * Ensure the `ledgers` table holds close times for the given ledger indices,
 * fetching any that are missing from Clio (a cheap, locally-answered `ledger`
 * call) and caching them. Bounded and on-demand — used to fill the dashboard's
 * recent-transactions dates for backfilled ledgers the live tail never observed,
 * without re-introducing the eager O(all in-scope ledgers) capture ADR-014
 * removed. Best-effort: a fetch failure just leaves that ledger's date blank.
 */
export async function ensureLedgerCloseTimes(
  client: ClioReader,
  db: Database,
  ledgerIndices: readonly number[],
): Promise<void> {
  const unique = [...new Set(ledgerIndices)];
  if (unique.length === 0) return;
  const ledgers = new LedgerTimeRepository(db);

  const placeholders = unique.map((_, i) => `$${i + 1}`).join(",");
  const { rows } = await db.query<{ ledger_index: number | string }>(
    `SELECT ledger_index FROM ledgers WHERE ledger_index IN (${placeholders})`,
    unique,
  );
  const known = new Set(rows.map((r) => Number(r.ledger_index)));

  for (const ledgerIndex of unique) {
    if (known.has(ledgerIndex)) continue;
    try {
      const res = await client.request<{ ledger?: unknown }>({ command: "ledger", ledger_index: ledgerIndex });
      const iso = asString(asRecord(res.result.ledger)?.["close_time_iso"]);
      if (iso) await ledgers.record({ ledgerIndex, closeTimeIso: iso });
    } catch {
      // best-effort — leave the date blank on failure
    }
  }
}

/**
 * Resolve against only the close times already cached in `ledgers` (the live
 * tail fills these forward as it runs). No upstream calls — the default for
 * offline use and tests. Historical timestamps predating the tail resolve to
 * null unless a lazy resolver has populated them.
 */
export function tableLedgerTimeResolver(db: Database): LedgerTimeResolver {
  const ledgers = new LedgerTimeRepository(db);
  return (iso) => ledgers.resolveAtOrBefore(iso);
}

/**
 * Resolve a timestamp lazily: binary-search the archive's ledger-index range,
 * fetching each probed ledger's close time from Clio (a cheap, locally-answered
 * `ledger` call) and caching it in `ledgers`.
 *
 * This replaces eagerly capturing a close time for every in-scope ledger at
 * registration — O(ledgers) upstream calls whether or not anyone ever queries by
 * time. Here the cost is O(log range) calls on a cold cache, and zero unless a
 * time-based query is actually made; probes are cached, so repeated/nearby time
 * queries reuse them. Balances only change at in-scope ledgers, so resolving to
 * the ledger index in effect at the timestamp (even a non-archived one) and
 * summing deltas up to it is exact.
 */
export function lazyLedgerTimeResolver(client: ClioReader, db: Database): LedgerTimeResolver {
  const ledgers = new LedgerTimeRepository(db);
  return async (iso) => {
    const bounds = await db.query<{ lo: number | string | null; hi: number | string | null }>(
      "SELECT min(ledger_index) AS lo, max(ledger_index) AS hi FROM transactions",
    );
    const loRaw = bounds.rows[0]?.lo;
    const hiRaw = bounds.rows[0]?.hi;
    if (loRaw == null || hiRaw == null) return null;

    // Is ledger `mid`'s close time <= iso? Cached in `ledgers`, else fetched from
    // Clio (locally answered) and cached. Null when the ledger has no close time.
    const atOrBefore = async (mid: number): Promise<boolean | null> => {
      const compare = () =>
        db.query<{ le: boolean }>(
          "SELECT close_time_iso <= $1::timestamptz AS le FROM ledgers WHERE ledger_index = $2",
          [iso, mid],
        );
      let { rows } = await compare();
      if (rows.length === 0) {
        const res = await client.request<{ ledger?: unknown }>({ command: "ledger", ledger_index: mid });
        const closeIso = asString(asRecord(res.result.ledger)?.["close_time_iso"]);
        if (!closeIso) return null;
        await ledgers.record({ ledgerIndex: mid, closeTimeIso: closeIso });
        ({ rows } = await compare());
      }
      return rows[0]?.le ?? null;
    };

    let lo = Number(loRaw);
    let hi = Number(hiRaw);
    let answer: number | null = null;
    while (lo <= hi) {
      const mid = lo + Math.floor((hi - lo) / 2);
      const le = await atOrBefore(mid);
      if (le === null) {
        hi = mid - 1; // unknown close time: narrow toward older, well-defined ledgers
      } else if (le) {
        answer = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return answer;
  };
}
