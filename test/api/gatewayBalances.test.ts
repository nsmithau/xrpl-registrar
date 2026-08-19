import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ArchiveApi } from "../../src/api/handler.js";
import { openArchiveDatabase, type Database } from "../../src/db/index.js";
import { AccountRepository } from "../../src/db/repositories/accounts.js";
import { IssuanceRepository } from "../../src/db/repositories/issuances.js";
import { TransactionRepository } from "../../src/db/repositories/transactions.js";
import { LedgerTimeRepository } from "../../src/db/repositories/ledgers.js";

const ISSUER = "rISSUER";
const PROV = { sourceEndpoint: "wss://clio.example", fetchedAt: "2026-08-12T00:00:00.000Z" };

// A single issuer (rISSUER) issuing three IOUs. Holders and hot-wallet, with
// deltas at ledgers 100 and 200 so point-in-time can be exercised. GBP nets to
// zero at the latest ledger (issued then fully redeemed) to prove zero
// obligations are omitted. Everything is covered over [100, 200].
describe("gateway_balances (IOU issuer)", () => {
  let db: Database;
  let api: ArchiveApi;

  beforeEach(async () => {
    db = await openArchiveDatabase();
    api = new ArchiveApi({ db });
    const issuances = new IssuanceRepository(db);
    const usd = await issuances.create({ kind: "iou", currency: "USD", issuerAccount: ISSUER });
    const eur = await issuances.create({ kind: "iou", currency: "EUR", issuerAccount: ISSUER });
    const gbp = await issuances.create({ kind: "iou", currency: "GBP", issuerAccount: ISSUER });

    const accounts = new AccountRepository(db);
    const disc = (id: number, addrs: string[]) =>
      accounts.recordDiscovered(
        id,
        addrs.map((address) => ({
          address,
          discoveredVia: "issuer_sweep" as const,
          firstAcquisitionLedger: 100,
        })),
      );
    await disc(usd.id, ["rH1", "rH2", "rHOT"]);
    await disc(eur.id, ["rH1"]);
    await disc(gbp.id, ["rH3"]);

    const txns = new TransactionRepository(db);
    const tx = (hash: string, ledgerIndex: number, accts: string[]) =>
      txns.ingest({
        hash,
        ledgerIndex,
        txType: "Payment",
        txBlob: new Uint8Array([1]),
        metaBlob: new Uint8Array([2]),
        provenance: PROV,
        accounts: accts,
      });
    await tx("T1", 100, ["rH1", "rH2", "rHOT"]); // USD activity at ledger 100
    await tx("T2", 200, ["rH1"]); // USD change at ledger 200
    await tx("E1", 100, ["rH1"]); // EUR at ledger 100
    await tx("G1", 100, ["rH3"]); // GBP issue at ledger 100
    await tx("G2", 200, ["rH3"]); // GBP redeem at ledger 200

    const delta = (hash: string, address: string, issuanceId: number, d: string) =>
      db.query(
        "INSERT INTO balance_deltas (hash, address, issuance_id, delta) VALUES ($1,$2,$3,$4)",
        [hash, address, issuanceId, d],
      );
    // USD: rH1 100 then -40 (=60); rH2 50; rHOT 30.
    await delta("T1", "rH1", usd.id, "100");
    await delta("T2", "rH1", usd.id, "-40");
    await delta("T1", "rH2", usd.id, "50");
    await delta("T1", "rHOT", usd.id, "30");
    // EUR: rH1 20.
    await delta("E1", "rH1", eur.id, "20");
    // GBP: rH3 +10 then -10 (=0 at latest, =10 at ledger 100).
    await delta("G1", "rH3", gbp.id, "10");
    await delta("G2", "rH3", gbp.id, "-10");

    for (const address of ["rH1", "rH2", "rHOT", "rH3"]) {
      await db.query(
        "INSERT INTO coverage (address, from_ledger, to_ledger, reason) VALUES ($1,100,200,'t')",
        [address],
      );
    }
    await new LedgerTimeRepository(db).recordMany([
      { ledgerIndex: 100, closeTimeIso: "2026-01-01T00:00:00Z" },
      { ledgerIndex: 200, closeTimeIso: "2026-06-01T00:00:00Z" },
    ]);
  });

  afterEach(async () => {
    await db.close();
  });

  it("sums every in-scope holder into per-currency obligations (multi-currency), omitting zero", async () => {
    const res = await api.handle({ command: "gateway_balances", account: ISSUER, api_version: 2 });
    expect(res.result.status).toBe("success");
    expect(res.result.account).toBe(ISSUER);
    // USD = 60 + 50 + 30 (no hotwallet designated); EUR = 20; GBP nets to 0 → omitted.
    expect(res.result.obligations).toEqual({ USD: "140", EUR: "20" });
    expect(res.result.balances).toBeUndefined(); // no hotwallets requested
    expect(res.result.ledger_index).toBe(200); // defaults to the archive's latest
  });

  it("breaks a hot wallet out of obligations into balances", async () => {
    const res = await api.handle({
      command: "gateway_balances",
      account: ISSUER,
      hotwallet: "rHOT",
      api_version: 2,
    });
    expect(res.result.obligations).toEqual({ USD: "110", EUR: "20" }); // rHOT's 30 removed from USD
    expect(res.result.balances).toEqual({ rHOT: [{ currency: "USD", value: "30" }] });
  });

  it("accepts a hotwallet array", async () => {
    const res = await api.handle({
      command: "gateway_balances",
      account: ISSUER,
      hotwallet: ["rHOT", "rH2"],
      api_version: 2,
    });
    expect(res.result.obligations).toEqual({ USD: "60", EUR: "20" }); // only rH1 left in USD obligations
    expect(res.result.balances).toEqual({
      rHOT: [{ currency: "USD", value: "30" }],
      rH2: [{ currency: "USD", value: "50" }],
    });
  });

  it("answers as of a past ledger", async () => {
    const res = await api.handle({
      command: "gateway_balances",
      account: ISSUER,
      ledger_index: 150,
      api_version: 2,
    });
    // Only ledger-100 deltas count: USD = 100 + 50 + 30 = 180; EUR 20; GBP 10 (not yet redeemed).
    expect(res.result.ledger_index).toBe(150);
    expect(res.result.obligations).toEqual({ USD: "180", EUR: "20", GBP: "10" });
  });

  it("attaches the assets-not-tracked warning and omits the assets field", async () => {
    const res = await api.handle({ command: "gateway_balances", account: ISSUER, api_version: 2 });
    expect(res.warnings.map((w) => w.id)).toContain(65004);
    expect(res.result).not.toHaveProperty("assets");
  });

  it("fails closed for an account that issues no tracked IOU", async () => {
    const res = await api.handle({
      command: "gateway_balances",
      account: "rNOBODY",
      api_version: 2,
    });
    expect(res.result.error).toBe("notInArchive");
  });

  it("refuses a ledger outside coverage rather than under-counting", async () => {
    const beyond = await api.handle({
      command: "gateway_balances",
      account: ISSUER,
      ledger_index: 500,
      api_version: 2,
    });
    expect(beyond.result.error).toBe("outOfCoverage");
    const before = await api.handle({
      command: "gateway_balances",
      account: ISSUER,
      ledger_index: 50,
      api_version: 2,
    });
    expect(before.result.error).toBe("outOfCoverage");
  });

  it("validates params", async () => {
    expect((await api.handle({ command: "gateway_balances", api_version: 2 })).result.error).toBe(
      "invalidParams",
    );
    expect(
      (
        await api.handle({
          command: "gateway_balances",
          account: ISSUER,
          hotwallet: 42,
          api_version: 2,
        })
      ).result.error,
    ).toBe("invalidParams");
  });
});
