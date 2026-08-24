import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ActivityRegistry } from "../../src/admin/activity.js";
import { AdminApi } from "../../src/admin/adminApi.js";
import { AdminServer } from "../../src/admin/adminServer.js";
import { AccountRepository } from "../../src/db/repositories/accounts.js";
import type { IssuanceRecord } from "../../src/db/repositories/issuances.js";
import { openArchiveDatabase, type Database } from "../../src/db/index.js";

const TOKEN = "s3cret-admin-token";

describe("AdminServer", () => {
  let db: Database;
  let server: AdminServer;
  let base: string;
  let activity: ActivityRegistry;
  const registered: IssuanceRecord[] = [];

  const auth = (extra: Record<string, string> = {}) => ({
    authorization: `Bearer ${TOKEN}`,
    ...extra,
  });

  beforeAll(async () => {
    db = await openArchiveDatabase();
    activity = new ActivityRegistry();
    server = new AdminServer({
      api: new AdminApi(db, activity),
      token: TOKEN,
      port: 0,
      onRegistered: (i) => registered.push(i),
    });
    const port = await server.start();
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await server.stop();
    await db.close();
  });

  it("rejects unauthenticated requests", async () => {
    expect((await fetch(`${base}/admin/issuances`)).status).toBe(401);
    const wrong = await fetch(`${base}/admin/issuances`, {
      headers: { authorization: "Bearer nope" },
    });
    expect(wrong.status).toBe(401);
  });

  it("serves the read-only dashboard shell without auth (no data in it)", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("operator dashboard");
  });

  it("exchanges the token at /admin/login for an httpOnly session cookie that authorizes in its place", async () => {
    // Wrong token is rejected, no cookie minted.
    const bad = await fetch(`${base}/admin/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "wrong" }),
    });
    expect(bad.status).toBe(401);

    // Correct token mints a hardened session cookie.
    const ok = await fetch(`${base}/admin/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: TOKEN }),
    });
    expect(ok.status).toBe(200);
    const setCookie = ok.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/adm_session=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    const cookie = setCookie.split(";")[0]!; // adm_session=<id>

    // The cookie authorizes with no bearer header.
    const list = await fetch(`${base}/admin/issuances`, { headers: { cookie } });
    expect(list.status).toBe(200);

    // Logout invalidates the session; the same cookie no longer authorizes.
    const out = await fetch(`${base}/admin/logout`, { method: "POST", headers: { cookie } });
    expect(out.status).toBe(200);
    const after = await fetch(`${base}/admin/issuances`, { headers: { cookie } });
    expect(after.status).toBe(401);
  });

  it("registers an issuance and fires onRegistered", async () => {
    const res = await fetch(`${base}/admin/issuances`, {
      method: "POST",
      headers: auth({ "content-type": "application/json" }),
      body: JSON.stringify({ kind: "mpt", mptIssuanceId: "MPT_A" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { issuance: IssuanceRecord };
    expect(body.issuance.mptIssuanceId).toBe("MPT_A");
    expect(registered.map((i) => i.mptIssuanceId)).toContain("MPT_A");
  });

  it("lists, inspects, and toggles issuances", async () => {
    const list = (await (await fetch(`${base}/admin/issuances`, { headers: auth() })).json()) as {
      issuances: IssuanceRecord[];
    };
    expect(list.issuances.length).toBe(1);
    const id = list.issuances[0]!.id;

    const status = await (await fetch(`${base}/admin/issuances/${id}`, { headers: auth() })).json();
    expect((status as { issuance: IssuanceRecord }).issuance.id).toBe(id);

    const patch = await fetch(`${base}/admin/issuances/${id}`, {
      method: "PATCH",
      headers: auth({ "content-type": "application/json" }),
      body: JSON.stringify({ enabled: false }),
    });
    expect(patch.status).toBe(200);
    const after = (await (
      await fetch(`${base}/admin/issuances/${id}`, { headers: auth() })
    ).json()) as {
      issuance: IssuanceRecord;
    };
    expect(after.issuance.enabled).toBe(false);
  });

  it("reports background activity in the list response for the dashboard", async () => {
    activity.begin("backfill", "backfilling rX");
    const running = (await (
      await fetch(`${base}/admin/issuances`, { headers: auth() })
    ).json()) as {
      activity: {
        backfill: { running: boolean; detail: string | null };
        discovery: { running: boolean };
      };
    };
    expect(running.activity.backfill.running).toBe(true);
    expect(running.activity.backfill.detail).toBe("backfilling rX");
    expect(running.activity.discovery.running).toBe(false);

    activity.end("backfill");
    const idle = (await (await fetch(`${base}/admin/issuances`, { headers: auth() })).json()) as {
      activity: { backfill: { running: boolean } };
    };
    expect(idle.activity.backfill.running).toBe(false);
  });

  it("rejects a malformed IOU currency with a 400 (not a 500)", async () => {
    const res = await fetch(`${base}/admin/issuances`, {
      method: "POST",
      headers: auth({ "content-type": "application/json" }),
      body: JSON.stringify({ kind: "iou", currency: "XRP", issuer: "rISS" }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toMatch(/XRP/);
  });

  it("404s unknown ids and paths", async () => {
    expect((await fetch(`${base}/admin/issuances/9999`, { headers: auth() })).status).toBe(404);
    expect((await fetch(`${base}/admin/other`, { headers: auth() })).status).toBe(404);
  });

  it("samples random holders of an issuance (for the balance smoke test)", async () => {
    const reg = await fetch(`${base}/admin/issuances`, {
      method: "POST",
      headers: auth({ "content-type": "application/json" }),
      body: JSON.stringify({ kind: "iou", currency: "USD", issuer: "rHoldersIss" }),
    });
    const { issuance } = (await reg.json()) as { issuance: { id: number } };
    await new AccountRepository(db).recordDiscovered(
      issuance.id,
      ["rHa", "rHb", "rHc"].map((address) => ({
        address,
        discoveredVia: "issuer_sweep" as const,
        firstAcquisitionLedger: 1,
      })),
    );

    const res = await fetch(`${base}/admin/issuances/${issuance.id}/holders?limit=2`, {
      headers: auth(),
    });
    expect(res.status).toBe(200);
    const { holders } = (await res.json()) as { holders: string[] };
    expect(holders).toHaveLength(2);
    expect(holders.every((h) => ["rHa", "rHb", "rHc"].includes(h))).toBe(true);
  });

  it("deletes an issuance over HTTP and 404s an unknown id", async () => {
    const reg = await fetch(`${base}/admin/issuances`, {
      method: "POST",
      headers: auth({ "content-type": "application/json" }),
      body: JSON.stringify({ kind: "iou", currency: "USD", issuer: "rHttpDel" }),
    });
    const { issuance } = (await reg.json()) as { issuance: { id: number } };
    const del = await fetch(`${base}/admin/issuances/${issuance.id}`, {
      method: "DELETE",
      headers: auth(),
    });
    expect(del.status).toBe(200);
    const summary = (await del.json()) as { issuanceId: number; compacted: boolean };
    expect(summary.issuanceId).toBe(issuance.id);
    expect(summary.compacted).toBe(true);
    expect(
      (await fetch(`${base}/admin/issuances/999999`, { method: "DELETE", headers: auth() })).status,
    ).toBe(404);
  });

  it("rejects other mutations with 409 while a delete + vacuum is in progress", async () => {
    // A dedicated server whose delete hangs on a gate, so the maintenance lock
    // stays held while we fire a concurrent registration.
    const db2 = await openArchiveDatabase();
    const api2 = new AdminApi(db2);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    api2.deleteIssuance = async (id: number) => {
      await gate;
      return {
        issuanceId: id,
        accountsRemoved: 0,
        transactionsRemoved: 0,
        deltasRemoved: 0,
        compacted: true,
      };
    };
    const srv = new AdminServer({ api: api2, token: TOKEN, port: 0 });
    const p = await srv.start();
    const b2 = `http://127.0.0.1:${p}`;
    try {
      const del = fetch(`${b2}/admin/issuances/1`, { method: "DELETE", headers: auth() });
      await new Promise((r) => setTimeout(r, 30)); // let the delete acquire the lock
      const reg = await fetch(`${b2}/admin/issuances`, {
        method: "POST",
        headers: auth({ "content-type": "application/json" }),
        body: JSON.stringify({ kind: "mpt", mptIssuanceId: "MPT_BLOCKED" }),
      });
      expect(reg.status).toBe(409);
      release();
      expect((await del).status).toBe(200);
    } finally {
      await srv.stop();
      await db2.close();
    }
  });
});
