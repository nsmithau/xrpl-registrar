import { describe, expect, it } from "vitest";

import { issuanceScope } from "../../src/livetail/issuanceScope.js";
import type { TrackedIssuance } from "../../src/reconcile/incremental.js";
import { decodeMptIssuer } from "../../src/xrpl/mpt.js";

const MPT = "0128C74F0A3198D6E71DE4A6F39C3AD08BD1215358949AE1";
const ISSUER = decodeMptIssuer(MPT);
const tracked: TrackedIssuance[] = [{ id: 1, kind: "mpt", mptIssuanceId: MPT, currency: null, issuer: null }];

const mptNode = (owner: string, id: string) => ({
  ModifiedNode: { LedgerEntryType: "MPToken", FinalFields: { Account: owner, MPTokenIssuanceID: id } },
});

describe("issuanceScope", () => {
  const scope = issuanceScope(() => tracked);

  it("returns the tracked-issuance holders it touches, plus the issuer", () => {
    // A holder-to-holder transfer of the tracked MPT modifies both MPTokens.
    const meta = { AffectedNodes: [mptNode("rSender", MPT), mptNode("rRecipient", MPT)] };
    expect(scope(null, meta).sort()).toEqual([ISSUER, "rRecipient", "rSender"].sort());
  });

  it("drops a transaction that touches no tracked issuance (the TrustSet case)", () => {
    // A TrustSet: a RippleState node, but no tracked IOU issuance to match.
    const trustSet = {
      AffectedNodes: [
        { CreatedNode: { LedgerEntryType: "RippleState", NewFields: { Balance: { currency: "USD", value: "0" } } } },
      ],
    };
    expect(scope(null, trustSet)).toEqual([]);
    // An MPToken for a *different*, untracked MPT is also dropped.
    const otherMpt = { AffectedNodes: [mptNode("rHolder", "0199999900000000000000000000000000000000DEADBEEF")] };
    expect(scope(null, otherMpt)).toEqual([]);
  });

  it("returns empty for missing or malformed metadata", () => {
    expect(scope(null, null)).toEqual([]);
    expect(scope(null, { AffectedNodes: [] })).toEqual([]);
  });
});
