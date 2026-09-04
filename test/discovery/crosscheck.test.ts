import { describe, expect, it } from "vitest";

import { discover } from "../../src/discovery/discover.js";
import { currentTrustlineHolders } from "../../src/discovery/accountLines.js";
import type { ClioRequest } from "../../src/clio/types.js";

import { fakeReader, txEntry } from "./fakes.js";

const ISSUER = "rIssuer";
const TOKEN_HEX = "544F4B454E000000000000000000000000000000";

// A fake that answers both TrustSet history (account_tx) and current lines
// (account_lines), so we can exercise the historical-vs-current diff.
function ledgerFake(historicalHolders: string[], currentHolders: string[]) {
  return fakeReader((req: ClioRequest) => {
    if (req.command === "account_tx") {
      return {
        transactions: historicalHolders.map((account, i) =>
          txEntry(100 + i, {
            TransactionType: "TrustSet",
            Account: account,
            LimitAmount: { currency: TOKEN_HEX, issuer: ISSUER, value: "100" },
          }),
        ),
      };
    }
    if (req.command === "account_lines") {
      return { lines: currentHolders.map((account) => ({ account, currency: TOKEN_HEX })) };
    }
    return {};
  });
}

describe("currentTrustlineHolders", () => {
  it("returns current line holders for the currency", async () => {
    const client = ledgerFake([], ["rA", "rB"]);
    expect(await currentTrustlineHolders(client, ISSUER, "TOKEN")).toEqual(new Set(["rA", "rB"]));
  });
});

describe("IOU discovery cross-check", () => {
  it("reports a clean cross-check when current holders are a subset of historical", async () => {
    // Historical opened lines: rA, rB, rC. Current still open: rA, rC (rB closed).
    const client = ledgerFake(["rA", "rB", "rC"], ["rA", "rC"]);
    const res = await discover(client, { kind: "iou", currency: "TOKEN", issuer: ISSUER });

    expect(res.strategy).toBe("trustline");
    expect(res.accounts.map((a) => a.address)).toEqual(["rA", "rB", "rC"]); // rB retained
    expect(res.crossCheck).toEqual({
      method: "account_lines",
      currentCount: 2,
      missingFromHistorical: [],
    });
  });

  it("surfaces a current holder missing from the historical set and unions it in", async () => {
    // rZ is a current holder the historical scan somehow missed -> defect signal.
    const client = ledgerFake(["rA"], ["rA", "rZ"]);
    const res = await discover(client, { kind: "iou", currency: "TOKEN", issuer: ISSUER });

    expect(res.crossCheck?.missingFromHistorical).toEqual(["rZ"]);
    expect(res.accounts.map((a) => a.address)).toEqual(["rA", "rZ"]); // unioned to stay complete
  });

  it("skips the cross-check when disabled", async () => {
    const client = ledgerFake(["rA"], ["rA"]);
    const res = await discover(
      client,
      { kind: "iou", currency: "TOKEN", issuer: ISSUER },
      { crossCheck: false },
    );
    expect(res.crossCheck).toBeUndefined();
    expect(res.accounts.map((a) => a.address)).toEqual(["rA"]);
  });

  it("logs a start and finish line when a logger is supplied", async () => {
    const client = ledgerFake(["rA", "rB"], ["rA", "rB"]);
    const logs: Array<{ message: string; meta?: Record<string, unknown> }> = [];
    const logger = {
      info: (message: string, meta?: Record<string, unknown>) =>
        logs.push({ message, ...(meta ? { meta } : {}) }),
      warn: () => {},
      error: () => {},
    };

    await discover(client, { kind: "iou", currency: "TOKEN", issuer: ISSUER }, { logger });

    const messages = logs.map((l) => l.message);
    expect(messages).toContain("discovery started");
    expect(messages).toContain("discovery finished");
    const finished = logs.find((l) => l.message === "discovery finished");
    expect(finished?.meta?.["strategy"]).toBe("trustline");
    expect(finished?.meta?.["accounts"]).toBe(2);
    expect(finished?.meta).toHaveProperty("elapsedMs");
  });
});
