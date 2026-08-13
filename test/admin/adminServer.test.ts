import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ActivityRegistry } from "../../src/admin/activity.js";
import { AdminApi } from "../../src/admin/adminApi.js";
import { AdminServer } from "../../src/admin/adminServer.js";
import type { IssuanceRecord } from "../../src/db/repositories/issuances.js";
import { openArchiveDatabase, type Database } from "../../src/db/index.js";

const TOKEN = "s3cret-admin-token";

describe("AdminServer", () => {
  let db: Database;
  let server: AdminServer;
  let base: string;
  let activity: ActivityRegistry;
  const registered: IssuanceRecord[] = [];

  const auth = (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${TOKEN}`, ...extra });

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
    const wrong = await fetch(`${base}/admin/issuances`, { headers: { authorization: "Bearer nope" } });
    expect(wrong.status).toBe(401);
  });

  it("serves the read-only dashboard shell without auth (no data in it)", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("operator dashboard");
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
    const after = (await (await fetch(`${base}/admin/issuances/${id}`, { headers: auth() })).json()) as {
      issuance: IssuanceRecord;
    };
    expect(after.issuance.enabled).toBe(false);
  });

  it("reports background activity in the list response for the dashboard", async () => {
    activity.begin("backfill", "backfilling rX");
    const running = (await (await fetch(`${base}/admin/issuances`, { headers: auth() })).json()) as {
      activity: { backfill: { running: boolean; detail: string | null }; discovery: { running: boolean } };
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

  it("404s unknown ids and paths", async () => {
    expect((await fetch(`${base}/admin/issuances/9999`, { headers: auth() })).status).toBe(404);
    expect((await fetch(`${base}/admin/other`, { headers: auth() })).status).toBe(404);
  });
});
