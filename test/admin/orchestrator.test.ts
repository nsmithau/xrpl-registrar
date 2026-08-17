import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AdminApi } from "../../src/admin/adminApi.js";
import { ingestIssuance } from "../../src/admin/orchestrator.js";
import { openArchiveDatabase, type Database } from "../../src/db/index.js";
import { IssuanceRepository } from "../../src/db/repositories/issuances.js";
import type { ClioRequest } from "../../src/clio/types.js";
import { decodeMptIssuer } from "../../src/xrpl/mpt.js";
import { fakeReader } from "../discovery/fakes.js";

// A valid-format MPTokenIssuanceID (48 hex): ingestIssuance decodes the issuer
// address from it, so the shape must be real even though the network is faked.
const MPT = "0128C74F0A3198D6E71DE4A6F39C3AD08BD1215358949AE1";

describe("ingestIssuance", () => {
  let db: Database;

  beforeEach(async () => {
    db = await openArchiveDatabase();
  });
  afterEach(async () => {
    await db.close();
  });

  it("backfills an issuance with a single account_tx sweep on its issuer", async () => {
    // One issuer sweep (binary account_tx) drives the whole pipeline; returning
    // no transactions exercises the wiring end to end without decodable blobs.
    const sweptAccounts: string[] = [];
    const client = fakeReader((req: ClioRequest) => {
      if (req.command !== "account_tx") return {};
      sweptAccounts.push(String(req.account));
      return { transactions: [] };
    });

    const iss = await new AdminApi(db).registerIssuance({ kind: "mpt", mptIssuanceId: MPT });

    const summary = await ingestIssuance(client, db, iss);
    expect(summary).toMatchObject({ strategy: "issuer_sweep", discovered: 0, deltaRows: 0 });

    // Swept the issuer decoded from the MPT id, exactly once — not one call per
    // holder and not a request per ledger.
    expect(sweptAccounts).toEqual([decodeMptIssuer(MPT)]);

    const status = (await new AdminApi(db).getIssuance(iss.id))!;
    expect(status.backfill.completed).toBe(1); // the single issuer sweep job
  });

  it("captures the MPT ticker from on-ledger metadata at ingest", async () => {
    const metaHex = Buffer.from(JSON.stringify({ t: "FGOLD", n: "Fake Gold" }), "utf8").toString("hex");
    const client = fakeReader((req: ClioRequest) => {
      if (req.command === "ledger_entry") return { node: { MPTokenMetadata: metaHex } };
      if (req.command === "account_tx") return { transactions: [] };
      return {};
    });
    const iss = await new AdminApi(db).registerIssuance({ kind: "mpt", mptIssuanceId: MPT });

    await ingestIssuance(client, db, iss);

    const stored = await new IssuanceRepository(db).getById(iss.id);
    expect(stored!.ticker).toBe("FGOLD");
  });

  it("leaves the ticker null when metadata is absent", async () => {
    const client = fakeReader((req: ClioRequest) => {
      if (req.command === "ledger_entry") return {}; // no node / no metadata
      return { transactions: [] };
    });
    const iss = await new AdminApi(db).registerIssuance({ kind: "mpt", mptIssuanceId: MPT });

    await ingestIssuance(client, db, iss);

    const stored = await new IssuanceRepository(db).getById(iss.id);
    expect(stored!.ticker).toBeNull();
  });

  it("is idempotent: a second run does not re-sweep a completed issuance", async () => {
    let sweeps = 0;
    const client = fakeReader((req: ClioRequest) => {
      if (req.command === "account_tx") sweeps += 1;
      return { transactions: [] };
    });
    const iss = await new AdminApi(db).registerIssuance({ kind: "mpt", mptIssuanceId: MPT });

    await ingestIssuance(client, db, iss);
    await ingestIssuance(client, db, iss); // job already completed → skipped

    expect(sweeps).toBe(1);
  });
});
