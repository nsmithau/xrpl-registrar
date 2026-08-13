import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AdminApi } from "../../src/admin/adminApi.js";
import { ingestIssuance } from "../../src/admin/orchestrator.js";
import { openArchiveDatabase, type Database } from "../../src/db/index.js";
import type { ClioRequest } from "../../src/clio/types.js";
import { fakeReader, txEntry } from "../discovery/fakes.js";

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

  it("discovers, records accounts, backfills, and derives for an issuance", async () => {
    // Discovery (JSON account_tx, tx_type filter) finds two holders; backfill
    // (binary account_tx) returns nothing, so the wiring runs end to end
    // without needing decodable blobs.
    const client = fakeReader((req: ClioRequest) => {
      if (req.command !== "account_tx") return {};
      if (req.binary === true) return { transactions: [], marker: undefined };
      return {
        transactions: [
          txEntry(10, { TransactionType: "MPTokenAuthorize", Account: "rH1", MPTokenIssuanceID: MPT }),
          txEntry(11, { TransactionType: "MPTokenAuthorize", Account: "rH2", MPTokenIssuanceID: MPT }),
        ],
      };
    });

    const iss = await new AdminApi(db).registerIssuance({
      kind: "mpt",
      mptIssuanceId: MPT,
      discoveryStrategy: "authorization",
    });

    const summary = await ingestIssuance(client, db, iss);
    expect(summary).toMatchObject({ strategy: "authorization", discovered: 2, deltaRows: 0 });

    const status = (await new AdminApi(db).getIssuance(iss.id))!;
    expect(status.accounts).toBe(2);
    expect(status.backfill.completed).toBe(2); // one job per discovered account
  });
});
