/**
 * Global concurrency governor.
 *
 * Concurrency is governed **globally, not per issuance**. Ten tracked issuances
 * must not mean ten times the upstream load. The governor lives inside the Clio
 * client because that is the single chokepoint every upstream request passes
 * through.
 *
 * It does two things, both of them global:
 *
 *  1. Caps the number of in-flight upstream requests (a semaphore).
 *  2. Applies an **honest, increasing backoff** whenever upstream sheds load.
 *     A load signal on *any* request pauses *all* requests — because rate
 *     limiting on a shared cluster is global, so our response must be too.
 *     Be a good citizen to whatever upstream you point at.
 *
 * This is the in-process implementation. When backfill fans out across worker
 * threads or child processes, the same interface must be backed by a
 * coordinator shared across workers (parent process or a shared store) rather
 * than per-worker counters. Keep that seam in mind: nothing outside this file
 * should hold its own concurrency counter.
 */

/** A single rate-limit / load-shed observation, surfaced for the dashboard. */
export interface RateLimitEvent {
  /** Wall-clock time the penalty was applied. */
  readonly at: Date;
  /** Upstream endpoint that shed load, when known. */
  readonly endpoint: string | undefined;
  /** Backoff applied for this penalty, in milliseconds. */
  readonly backoffMs: number;
  /** How many consecutive penalties without an intervening clean success. */
  readonly consecutive: number;
  /** Epoch-ms until which all requests are held. */
  readonly cooldownUntil: number;
}

export interface GovernorOptions {
  /** Max concurrent in-flight upstream requests. Conservative by design. */
  readonly maxConcurrent: number;
  /** First backoff step, in ms. */
  readonly minBackoffMs: number;
  /** Backoff ceiling, in ms. */
  readonly maxBackoffMs: number;
  /** Exponential growth factor between consecutive penalties. */
  readonly backoffFactor: number;
}

/** Injectable clock/timer, so backoff logic is testable without real waits. */
export interface GovernorClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const DEFAULT_GOVERNOR_OPTIONS: GovernorOptions = {
  // Conservative on purpose: the upstream is typically a shared, public cluster
  // that may not be intended for sustained heavy use.
  maxConcurrent: 4,
  minBackoffMs: 1_000,
  maxBackoffMs: 60_000,
  backoffFactor: 2,
};

const realClock: GovernorClock = {
  now: () => Date.now(),
  sleep: (ms) =>
    new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      // Do not keep the event loop alive purely for a backoff timer.
      if (typeof t.unref === "function") t.unref();
    }),
};

/** Released exactly once to return a concurrency slot to the pool. */
export type SlotRelease = () => void;

type Listener<T> = (payload: T) => void;

/** Minimal typed event source — the dashboard subscribes to rate-limit events. */
class Emitter<T> {
  readonly #listeners = new Set<Listener<T>>();

  on(listener: Listener<T>): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  emit(payload: T): void {
    for (const listener of this.#listeners) listener(payload);
  }
}

export interface GovernorStats {
  readonly inFlight: number;
  readonly queued: number;
  readonly maxConcurrent: number;
  readonly currentBackoffMs: number;
  readonly cooldownUntil: number;
  readonly consecutivePenalties: number;
  readonly totalPenalties: number;
}

export class Governor {
  readonly #opts: GovernorOptions;
  readonly #clock: GovernorClock;

  #inFlight = 0;
  readonly #waiters: Array<() => void> = [];

  #cooldownUntil = 0;
  #currentBackoffMs = 0;
  #consecutivePenalties = 0;
  #totalPenalties = 0;

  /** Rate-limit events, surfaced rather than only logged (arch §Concurrency). */
  readonly rateLimits = new Emitter<RateLimitEvent>();

  constructor(options: Partial<GovernorOptions> = {}, clock: GovernorClock = realClock) {
    this.#opts = { ...DEFAULT_GOVERNOR_OPTIONS, ...options };
    if (this.#opts.maxConcurrent < 1) {
      throw new RangeError("Governor maxConcurrent must be >= 1");
    }
    this.#clock = clock;
  }

  /**
   * Acquire a concurrency slot, respecting any active global cooldown. Resolves
   * once the caller may proceed. The returned callback MUST be invoked exactly
   * once when the request finishes (success or failure) to release the slot.
   */
  async acquire(): Promise<SlotRelease> {
    for (;;) {
      await this.#waitForCooldown();
      await this.#takeSlot();

      // A penalty may have landed while we were queued for a slot. If so, hand
      // the slot back and wait out the (now global) cooldown before retrying,
      // so a fresh penalty is never immediately undercut by an in-flight burst.
      if (this.#clock.now() < this.#cooldownUntil) {
        this.#releaseSlot();
        continue;
      }

      let released = false;
      return () => {
        if (released) return;
        released = true;
        this.#releaseSlot();
      };
    }
  }

  /**
   * Record a load signal from upstream (`slowDown`, a resource disconnect, a
   * timeout). Escalates the global backoff and holds all requests for the
   * resulting cooldown. Safe to call concurrently from many in-flight requests
   * hitting the same wall — the longest cooldown wins.
   */
  penalize(endpoint?: string): void {
    this.#consecutivePenalties += 1;
    this.#totalPenalties += 1;

    const step = this.#opts.minBackoffMs * this.#opts.backoffFactor ** (this.#consecutivePenalties - 1);
    const backoffMs = Math.min(this.#opts.maxBackoffMs, Math.round(step));
    this.#currentBackoffMs = backoffMs;

    const until = this.#clock.now() + backoffMs;
    if (until > this.#cooldownUntil) this.#cooldownUntil = until;

    this.rateLimits.emit({
      at: new Date(this.#clock.now()),
      endpoint,
      backoffMs,
      consecutive: this.#consecutivePenalties,
      cooldownUntil: this.#cooldownUntil,
    });
  }

  /**
   * Record a clean success. Resets the backoff escalation — but only once the
   * cooldown has actually elapsed, so a success from a request that slipped out
   * *before* a penalty landed cannot reset the escalation mid-cooldown.
   */
  reward(): void {
    if (this.#clock.now() >= this.#cooldownUntil) {
      this.#consecutivePenalties = 0;
      this.#currentBackoffMs = 0;
    }
  }

  stats(): GovernorStats {
    return {
      inFlight: this.#inFlight,
      queued: this.#waiters.length,
      maxConcurrent: this.#opts.maxConcurrent,
      currentBackoffMs: this.#currentBackoffMs,
      cooldownUntil: this.#cooldownUntil,
      consecutivePenalties: this.#consecutivePenalties,
      totalPenalties: this.#totalPenalties,
    };
  }

  async #waitForCooldown(): Promise<void> {
    for (;;) {
      const remaining = this.#cooldownUntil - this.#clock.now();
      if (remaining <= 0) return;
      await this.#clock.sleep(remaining);
      // Re-check: the cooldown may have been extended while we slept.
    }
  }

  #takeSlot(): Promise<void> {
    if (this.#inFlight < this.#opts.maxConcurrent) {
      this.#inFlight += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.#waiters.push(resolve);
    });
  }

  #releaseSlot(): void {
    const next = this.#waiters.shift();
    if (next) {
      // Transfer the slot directly to the next waiter; inFlight is unchanged.
      next();
    } else {
      this.#inFlight -= 1;
    }
  }
}
