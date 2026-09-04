import { describe, expect, it } from "vitest";

import { affectedAccounts } from "../../src/livetail/affected.js";

const scope = new Set(["rA", "rB"]);

describe("affectedAccounts", () => {
  it("picks up in-scope Account/Destination and ignores out-of-scope", () => {
    expect(affectedAccounts({ Account: "rA", Destination: "rZ" }, undefined, scope).sort()).toEqual(
      ["rA"],
    );
  });

  it("finds owners of affected ledger objects that are in scope", () => {
    const meta = {
      AffectedNodes: [
        { ModifiedNode: { LedgerEntryType: "MPToken", FinalFields: { Account: "rB" } } },
        { CreatedNode: { LedgerEntryType: "MPToken", NewFields: { Account: "rZ" } } },
      ],
    };
    expect(affectedAccounts({ Account: "rQ" }, meta, scope)).toEqual(["rB"]);
  });

  it("dedupes across fields and metadata", () => {
    const meta = {
      AffectedNodes: [{ ModifiedNode: { FinalFields: { Account: "rA" } } }],
    };
    expect(affectedAccounts({ Account: "rA", Destination: "rB" }, meta, scope).sort()).toEqual([
      "rA",
      "rB",
    ]);
  });
});
