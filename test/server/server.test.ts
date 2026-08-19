import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { Client } from "xrpl";

import { ArchiveApi } from "../../src/api/handler.js";
import type { Forwarder, ForwardResult } from "../../src/api/forwarder.js";
import type { ApiRequest } from "../../src/api/types.js";
import { ArchiveServer } from "../../src/server/server.js";
import { openArchiveDatabase, type Database } from "../../src/db/index.js";
import { IssuanceRepository } from "../../src/db/repositories/issuances.js";
import { TransactionRepository } from "../../src/db/repositories/transactions.js";

const PROV = { sourceEndpoint: "wss://clio.example", fetchedAt: "2026-08-12T00:00:00.000Z" };

// Fake upstream: gives xrpl.js a server_info with network_id so it can connect.
class FakeForwarder implements Forwarder {
  forward(req: ApiRequest): Promise<ForwardResult> {
    if (req.command === "server_info") {
      return Promise.resolve({
        result: {
          status: "success",
          info: {
            network_id: 1,
            build_version: "2.0.0",
            complete_ledgers: "1-100",
            validated_ledger: {
              seq: 100,
              age: 1,
              hash: "0".repeat(64),
              base_fee_xrp: 0.00001,
              reserve_base_xrp: 10,
              reserve_inc_xrp: 2,
            },
          },
        },
        warnings: [],
      });
    }
    return Promise.resolve({ result: { status: "success" }, warnings: [] });
  }
}

function wsRpc(url: string, msg: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on("open", () => ws.send(JSON.stringify(msg)));
    ws.on("message", (data) => {
      resolve(JSON.parse(data.toString()) as Record<string, unknown>);
      ws.close();
    });
    ws.on("error", reject);
  });
}

describe("ArchiveServer", () => {
  let db: Database;
  let server: ArchiveServer;
  let port: number;

  beforeAll(async () => {
    db = await openArchiveDatabase();
    await new IssuanceRepository(db).create({ kind: "mpt", mptIssuanceId: "MPT_A" });
    const txns = new TransactionRepository(db);
    await txns.ingest({
      hash: "T1",
      ledgerIndex: 100,
      txType: "Payment",
      txBlob: new Uint8Array([1]),
      metaBlob: new Uint8Array([2]),
      provenance: PROV,
      accounts: ["rInScope"],
    });
    await txns.ingest({
      hash: "T2",
      ledgerIndex: 200,
      txType: "Payment",
      txBlob: new Uint8Array([3]),
      metaBlob: new Uint8Array([4]),
      provenance: PROV,
      accounts: ["rInScope"],
    });
    await db.query(
      "INSERT INTO coverage (address, from_ledger, to_ledger, reason) VALUES ($1,$2,$3,$4)",
      ["rInScope", 100, 200, "test"],
    );

    const api = new ArchiveApi({ db, forwarder: new FakeForwarder() });
    server = new ArchiveServer({ api, port: 0 });
    port = await server.start();
  });

  afterAll(async () => {
    await server.stop();
    await db.close();
  });

  it("serves account_tx over HTTP JSON-RPC", async () => {
    const r = await fetch(`http://127.0.0.1:${port}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        method: "account_tx",
        params: [{ account: "rInScope", api_version: 2, binary: true }],
      }),
    });
    const body = (await r.json()) as { result: Record<string, unknown> };
    expect(body.result.status).toBe("success");
    expect((body.result.transactions as unknown[]).length).toBe(2);
    expect((body.result.warnings as { id: number }[]).map((w) => w.id)).toContain(2001);
  });

  it("serializes responses with keys sorted alphabetically at every level (Clio parity)", async () => {
    const r = await fetch(`http://127.0.0.1:${port}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        method: "account_tx",
        params: [{ account: "rInScope", api_version: 2, binary: true }],
      }),
    });
    const raw = await r.text();
    // The raw bytes equal the same object re-serialised with keys sorted — i.e.
    // the server already emitted sorted keys (recursively).
    const sortKeys = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(sortKeys)
        : v !== null && typeof v === "object"
          ? Object.fromEntries(
              Object.keys(v as Record<string, unknown>)
                .sort()
                .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
            )
          : v;
    expect(raw).toBe(JSON.stringify(sortKeys(JSON.parse(raw))));
    // Spot-check ordering within `result`.
    expect(raw.indexOf('"status"')).toBeLessThan(raw.indexOf('"validated"'));
  });

  it("rejects a missing api_version over HTTP", async () => {
    const r = await fetch(`http://127.0.0.1:${port}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "account_tx", params: [{ account: "rInScope" }] }),
    });
    const body = (await r.json()) as { result: Record<string, unknown> };
    expect(body.result.error).toBe("invalidApiVersion");
  });

  it("serves account_tx over WebSocket, echoing id and status", async () => {
    const res = await wsRpc(`ws://127.0.0.1:${port}`, {
      id: 7,
      command: "account_tx",
      account: "rInScope",
      api_version: 2,
      binary: true,
    });
    expect(res.id).toBe(7);
    expect(res.status).toBe("success");
    expect(res.type).toBe("response");
    expect(((res.result as Record<string, unknown>).transactions as unknown[]).length).toBe(2);
  });

  it("returns an error status over WebSocket for out-of-scope", async () => {
    const res = await wsRpc(`ws://127.0.0.1:${port}`, {
      id: 8,
      command: "account_tx",
      account: "rStranger",
      api_version: 2,
    });
    expect(res.status).toBe("error");
    expect((res.result as Record<string, unknown>).error).toBe("notInArchive");
  });

  it("is reachable by an xrpl.js client", async () => {
    const client = new Client(`ws://127.0.0.1:${port}`);
    await client.connect();
    try {
      const res = await client.request({
        command: "account_tx",
        account: "rInScope",
        binary: true,
      } as Parameters<Client["request"]>[0]);
      const result = res.result as Record<string, unknown>;
      expect((result.transactions as unknown[]).length).toBe(2);
    } finally {
      await client.disconnect();
    }
  });
});
