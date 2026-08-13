/**
 * In-process activity registry for the operator dashboard.
 *
 * Background work (backfill, discovery) is fire-and-forget from the admin
 * layer's point of view, so there is no request whose lifetime marks it "in
 * progress". This registry gives that work a place to announce itself: it holds
 * a reference count per activity kind plus the last start/finish timestamps, so
 * the dashboard can show a live "backfilling…" / "discovering…" indicator and,
 * when idle, when the work last ran.
 *
 * It is deliberately in-memory and process-local — it reflects what *this*
 * process is doing right now, which is exactly what an operator watching the
 * dashboard wants to see. It carries no archive data, so it never needs to be
 * persisted or authenticated on its own.
 */
export type ActivityKind = "backfill" | "discovery";

const KINDS: readonly ActivityKind[] = ["backfill", "discovery"];

export interface ActivitySnapshot {
  /** How many operations of this kind are in flight (0 when idle). */
  readonly active: number;
  readonly running: boolean;
  /** ISO time the most recent operation of this kind began, or null. */
  readonly lastStartedAt: string | null;
  /** ISO time the most recent operation of this kind finished, or null. */
  readonly lastFinishedAt: string | null;
  /** Human label for what is currently running (e.g. a heal range), or null. */
  readonly detail: string | null;
}

export type ActivityReport = Record<ActivityKind, ActivitySnapshot>;

/** Read side: the admin API only needs a snapshot to serve the dashboard. */
export interface ActivitySource {
  snapshot(): ActivityReport;
}

/** Write side: background work reports start/finish here. */
export interface ActivityTracker {
  track<T>(kind: ActivityKind, detail: string | undefined, fn: () => Promise<T>): Promise<T>;
}

interface KindState {
  active: number;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  detail: string | null;
}

export class ActivityRegistry implements ActivitySource, ActivityTracker {
  readonly #state = new Map<ActivityKind, KindState>();

  #get(kind: ActivityKind): KindState {
    let s = this.#state.get(kind);
    if (!s) {
      s = { active: 0, lastStartedAt: null, lastFinishedAt: null, detail: null };
      this.#state.set(kind, s);
    }
    return s;
  }

  begin(kind: ActivityKind, detail?: string): void {
    const s = this.#get(kind);
    s.active += 1;
    s.lastStartedAt = new Date().toISOString();
    if (detail !== undefined) s.detail = detail;
  }

  end(kind: ActivityKind): void {
    const s = this.#get(kind);
    s.active = Math.max(0, s.active - 1);
    s.lastFinishedAt = new Date().toISOString();
    if (s.active === 0) s.detail = null;
  }

  /** Run `fn`, marking this kind active for its duration (reference-counted, so
   * overlapping operations of the same kind stay "active" until the last ends).
   * Always ends, even if `fn` throws. */
  async track<T>(kind: ActivityKind, detail: string | undefined, fn: () => Promise<T>): Promise<T> {
    this.begin(kind, detail);
    try {
      return await fn();
    } finally {
      this.end(kind);
    }
  }

  snapshot(): ActivityReport {
    const report = {} as Record<ActivityKind, ActivitySnapshot>;
    for (const kind of KINDS) {
      const s = this.#get(kind);
      report[kind] = {
        active: s.active,
        running: s.active > 0,
        lastStartedAt: s.lastStartedAt,
        lastFinishedAt: s.lastFinishedAt,
        detail: s.detail,
      };
    }
    return report;
  }
}

/** A tracker that runs work without recording it — the default when no
 * dashboard/registry is wired in (tests, library use). */
export const noopActivityTracker: ActivityTracker = {
  track: (_kind, _detail, fn) => fn(),
};
