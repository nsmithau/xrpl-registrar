import { Client, decode } from "xrpl";

import { asRecord, asString } from "../discovery/fields.js";
import type { ClioReader } from "../discovery/types.js";
import { nullLogger, type Logger } from "../logging/logger.js";
import { hexToBytes } from "../util/hex.js";

import { affectedAccounts } from "./affected.js";
import type { TailEvent, TailSource, TransactionEvent } from "./types.js";

type QueueResult<T> = { done: false; value: T } | { done: true };

/** A minimal push/pull queue bridging event callbacks to an async iterator. */
class EventQueue<T> {
  #items: T[] = [];
  #waiters: Array<(r: QueueResult<T>) => void> = [];
  #closed = false;

  push(item: T): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ done: false, value: item });
    else this.#items.push(item);
  }

  close(): void {
    this.#closed = true;
    let waiter: ((r: QueueResult<T>) => void) | undefined;
    while ((waiter = this.#waiters.shift())) waiter({ done: true });
  }

  async *drain(): AsyncGenerator<T> {
    for (;;) {
      const item = this.#items.shift();
      if (item !== undefined) {
        yield item;
        continue;
      }
      if (this.#closed) return;
      const result = await new Promise<QueueResult<T>>((resolve) => this.#waiters.push(resolve));
      if (result.done) return;
      yield result.value;
    }
  }
}

export interface XrplTailSourceOptions {
  readonly endpoint: string;
  readonly accounts: string[];
  /** Governed client used to fetch canonical binary blobs by hash. */
  readonly reader: ClioReader;
  readonly connectionTimeout?: number;
  readonly logger?: Logger;
}

/**
 * Live tail source backed by xrpl.js `subscribe`.
 *
 * Subscribes to the `ledger` stream (for gap detection) and to the in-scope
 * accounts (for their transactions). Each validated transaction is resolved to
 * canonical binary via a `tx` fetch through the governed client, so live-tailed
 * rows are stored identically to backfilled ones.
 *
 * Note: dynamically extending the account subscription as discovery finds new
 * holders, plus reconnect/backpressure, are follow-ons.
 */
export class XrplTailSource implements TailSource {
  readonly #client: Client;
  readonly #reader: ClioReader;
  readonly #accounts: string[];
  readonly #scope: Set<string>;
  readonly #queue = new EventQueue<TailEvent>();
  readonly #logger: Logger;
  #started = false;

  constructor(options: XrplTailSourceOptions) {
    this.#client = new Client(
      options.endpoint,
      options.connectionTimeout !== undefined
        ? { connectionTimeout: options.connectionTimeout }
        : {},
    );
    this.#reader = options.reader;
    this.#accounts = options.accounts;
    this.#scope = new Set(options.accounts);
    this.#logger = options.logger ?? nullLogger;
  }

  async #start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;

    this.#client.on("ledgerClosed", (msg) => {
      const record = asRecord(msg);
      const ledgerIndex = record?.["ledger_index"];
      if (typeof ledgerIndex !== "number") return;
      const ledgerTime = record?.["ledger_time"]; // Ripple epoch (seconds since 2000-01-01)
      const closeTimeIso =
        typeof ledgerTime === "number"
          ? new Date((ledgerTime + 946_684_800) * 1000).toISOString()
          : undefined;
      this.#queue.push({
        type: "ledger",
        ledgerIndex,
        ...(closeTimeIso !== undefined ? { closeTimeIso } : {}),
      });
    });
    this.#client.on("transaction", (msg) => {
      this.#onTransaction(msg).catch((err: unknown) =>
        this.#logger.error("live tail transaction handler failed", { error: String(err) }),
      );
    });

    await this.#client.connect();
    await this.#client.request({
      command: "subscribe",
      streams: ["ledger"],
      accounts: this.#accounts,
    } as unknown as Parameters<Client["request"]>[0]);
  }

  async #onTransaction(msg: unknown): Promise<void> {
    const record = asRecord(msg);
    if (!record || record["validated"] !== true) return;

    const hash =
      asString(record["hash"]) ??
      asString(asRecord(record["tx_json"])?.["hash"]) ??
      asString(asRecord(record["transaction"])?.["hash"]);
    if (!hash) return;

    const touched = affectedAccounts(
      record["tx_json"] ?? record["transaction"],
      record["meta"] ?? record["metaData"],
      this.#scope,
    );
    if (touched.length === 0) return;

    const res = await this.#reader.request<{
      tx_blob?: string;
      meta_blob?: string;
      ledger_index?: number;
    }>({ command: "tx", transaction: hash, binary: true });

    const txBlob = asString(res.result.tx_blob);
    const metaBlob = asString(res.result.meta_blob);
    if (!txBlob || !metaBlob) return;

    const decoded = decode(txBlob) as { TransactionType?: string };
    const ledgerIndex =
      typeof res.result.ledger_index === "number"
        ? res.result.ledger_index
        : typeof record["ledger_index"] === "number"
          ? (record["ledger_index"] as number)
          : 0;

    const event: TransactionEvent = {
      type: "transaction",
      hash,
      ledgerIndex,
      txType: decoded.TransactionType ?? "unknown",
      accounts: touched,
      txBlob: hexToBytes(txBlob),
      metaBlob: hexToBytes(metaBlob),
      provenance: res.provenance,
    };
    this.#queue.push(event);
  }

  async *events(): AsyncGenerator<TailEvent> {
    await this.#start();
    yield* this.#queue.drain();
  }

  async close(): Promise<void> {
    this.#queue.close();
    if (this.#client.isConnected()) await this.#client.disconnect();
  }
}
