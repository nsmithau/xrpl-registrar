import type { GovernorClock } from "../src/clio/governor.js";
import type { ClioTransport } from "../src/clio/transport.js";
import type { ClioRawResponse, ClioRequest } from "../src/clio/types.js";

/** Flush the macrotask queue so pending governor/client awaits settle. */
export const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A deterministic clock. `sleep` registers a pending timer that only resolves
 * when the test calls `advance` past its deadline — no real time passes, so
 * backoff behaviour is tested exactly, not approximately.
 */
export class FakeClock implements GovernorClock {
  #t: number;
  #timers: Array<{ at: number; resolve: () => void }> = [];

  constructor(start = 0) {
    this.#t = start;
  }

  now(): number {
    return this.#t;
  }

  sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.#timers.push({ at: this.#t + ms, resolve });
    });
  }

  async advance(ms: number): Promise<void> {
    this.#t += ms;
    const due = this.#timers.filter((t) => t.at <= this.#t);
    this.#timers = this.#timers.filter((t) => t.at > this.#t);
    for (const t of due) t.resolve();
    await Promise.resolve();
  }
}

/** Build a xrpld-style error as xrpl.js surfaces it: an Error with `.data`. */
export function xrpldError(code: string): Error {
  const err = new Error(code) as Error & { data?: unknown };
  err.data = { error: code };
  return err;
}

/** Build a transport-level error identified by class name (as classify reads). */
export function namedError(name: string): Error {
  const err = new Error(name);
  err.name = name;
  return err;
}

export type TransportHandler = (req: ClioRequest, callIndex: number) => Promise<ClioRawResponse>;

/** A ClioTransport whose behaviour per call is driven by a handler. */
export class FakeTransport implements ClioTransport {
  readonly endpoint: string;
  readonly calls: ClioRequest[] = [];
  /** How many times connect() has been called (initial + reconnects). */
  connects = 0;
  #connected = false;
  #handler: TransportHandler;

  constructor(handler: TransportHandler, endpoint = "wss://test.example") {
    this.#handler = handler;
    this.endpoint = endpoint;
  }

  /** Simulate the socket dropping (a later request would see it disconnected). */
  drop(): void {
    this.#connected = false;
  }

  connect(): Promise<void> {
    this.#connected = true;
    this.connects += 1;
    return Promise.resolve();
  }

  disconnect(): Promise<void> {
    this.#connected = false;
    return Promise.resolve();
  }

  isConnected(): boolean {
    return this.#connected;
  }

  request(req: ClioRequest): Promise<ClioRawResponse> {
    const index = this.calls.length;
    this.calls.push(req);
    return this.#handler(req, index);
  }
}

/** Convenience: a transport that always returns the same success result. */
export function successTransport(result: Record<string, unknown> = { ok: true }): FakeTransport {
  return new FakeTransport(() => Promise.resolve({ result, status: "success" }));
}
