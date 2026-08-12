import { describe, expect, it } from "vitest";

import { traversal } from "../../src/discovery/strategies/traversal.js";
import type { ClioRequest } from "../../src/clio/types.js";

import { fakeReader, mptTokenNode, txEntry } from "./fakes.js";

const MPT = "MPT_A";
const ISSUER = "rI";

describe("traversal", () => {
  it("walks the transfer graph to closure and ignores unrelated transactions", async () => {
    // Graph: rI --mint--> rA --transfer--> rB. rB is a leaf. Plus an unrelated
    // (non-MPT) payment on rI that must not introduce a spurious account.
    const pages: Record<string, Record<string, unknown>> = {
      [ISSUER]: {
        transactions: [
          txEntry(5, { TransactionType: "Payment", Account: ISSUER, Destination: "rA" }, [
            mptTokenNode(ISSUER, MPT),
            mptTokenNode("rA", MPT),
          ]),
          // Unrelated XRP payment: no MPToken nodes -> ignored.
          txEntry(6, { TransactionType: "Payment", Account: ISSUER, Destination: "rZ" }, []),
        ],
      },
      rA: {
        transactions: [
          txEntry(8, { TransactionType: "Payment", Account: "rA", Destination: "rB" }, [
            mptTokenNode("rA", MPT),
            mptTokenNode("rB", MPT),
          ]),
        ],
      },
      rB: { transactions: [] },
    };

    const seenAccounts: string[] = [];
    const client = fakeReader((req: ClioRequest) => {
      const account = req.account as string;
      seenAccounts.push(account);
      return pages[account] ?? { transactions: [] };
    });

    const accounts = await traversal(client, MPT, ISSUER);
    const addresses = accounts.map((a) => a.address);

    expect(addresses).toEqual(["rA", "rB", "rI"]); // sorted; rZ excluded
    expect(accounts.every((a) => a.discoveredVia === "traversal")).toBe(true);
    // Each in-scope account visited exactly once (termination).
    expect(seenAccounts.sort()).toEqual(["rA", "rB", "rI"]);
    // firstAcquisitionLedger captured from the transfer ledger.
    expect(accounts.find((a) => a.address === "rB")?.firstAcquisitionLedger).toBe(8);
  });
});
