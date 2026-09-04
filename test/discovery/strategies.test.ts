import { describe, expect, it } from "vitest";

import { detectRequiresAuth } from "../../src/discovery/flags.js";
import { authorizationScan } from "../../src/discovery/strategies/authScan.js";
import { trustlineScan } from "../../src/discovery/strategies/trustlineScan.js";

import { fakeReader, txEntry } from "./fakes.js";

const ISSUER = "rIssuer";
const MPT = "MPT_A";
// "TOKEN" as a 40-hex non-standard currency code (ASCII + NUL padding).
const TOKEN_HEX = "544F4B454E000000000000000000000000000000";

describe("authorizationScan", () => {
  it("collects holders for the issuance, following markers, ignoring other issuances", async () => {
    const client = fakeReader((req) => {
      expect(req.command).toBe("account_tx");
      expect(req.tx_type).toBe("MPTokenAuthorize");
      if (req.marker === undefined) {
        return {
          transactions: [
            txEntry(10, {
              TransactionType: "MPTokenAuthorize",
              Account: "rH1",
              MPTokenIssuanceID: MPT,
            }),
            txEntry(11, {
              TransactionType: "MPTokenAuthorize",
              Account: "rH2",
              MPTokenIssuanceID: "OTHER",
            }),
            txEntry(12, {
              TransactionType: "MPTokenAuthorize",
              Account: ISSUER,
              Holder: "rH3",
              MPTokenIssuanceID: MPT,
            }),
          ],
          marker: "next",
        };
      }
      return {
        transactions: [
          // rH1 appears again later; earliest ledger (10) must win.
          txEntry(20, {
            TransactionType: "MPTokenAuthorize",
            Account: "rH1",
            MPTokenIssuanceID: MPT,
          }),
        ],
      };
    });

    const accounts = await authorizationScan(client, MPT, ISSUER);
    expect(accounts).toEqual([
      { address: "rH1", discoveredVia: "authorization", firstAcquisitionLedger: 10 },
      { address: "rH3", discoveredVia: "authorization", firstAcquisitionLedger: 12 },
    ]);
  });
});

describe("trustlineScan", () => {
  it("collects accounts that opened a line for the currency+issuer", async () => {
    const client = fakeReader((req) => {
      expect(req.tx_type).toBe("TrustSet");
      return {
        transactions: [
          txEntry(5, {
            TransactionType: "TrustSet",
            Account: "rA",
            LimitAmount: { currency: TOKEN_HEX, issuer: ISSUER, value: "100" },
          }),
          // wrong issuer
          txEntry(6, {
            TransactionType: "TrustSet",
            Account: "rB",
            LimitAmount: { currency: TOKEN_HEX, issuer: "rOther", value: "100" },
          }),
          // wrong currency
          txEntry(7, {
            TransactionType: "TrustSet",
            Account: "rC",
            LimitAmount: { currency: "USD", issuer: ISSUER, value: "100" },
          }),
        ],
      };
    });

    const accounts = await trustlineScan(client, "TOKEN", ISSUER);
    expect(accounts).toEqual([
      { address: "rA", discoveredVia: "trustline", firstAcquisitionLedger: 5 },
    ]);
  });
});

describe("detectRequiresAuth", () => {
  it("reads the require-auth ledger flag (0x0004)", async () => {
    expect(
      await detectRequiresAuth(
        fakeReader(() => ({ node: { Flags: 0x7e } })),
        MPT,
      ),
    ).toBe(true);
    expect(
      await detectRequiresAuth(
        fakeReader(() => ({ node: { Flags: 0x3a } })),
        MPT,
      ),
    ).toBe(false);
    expect(
      await detectRequiresAuth(
        fakeReader(() => ({})),
        MPT,
      ),
    ).toBe(false);
  });
});
