import { encodeAccountID } from "xrpl";

import { hexToBytes } from "../util/hex.js";

/**
 * An MPTokenIssuanceID is a 4-byte sequence followed by the 20-byte issuer
 * AccountID (48 hex chars total). The issuer address can therefore be recovered
 * from the id alone, with no network call.
 */
export function decodeMptIssuer(mptIssuanceId: string): string {
  const accountHex = mptIssuanceId.slice(8);
  return encodeAccountID(Buffer.from(hexToBytes(accountHex)));
}

/** The issuance sequence number encoded in the first 4 bytes. */
export function mptSequence(mptIssuanceId: string): number {
  return parseInt(mptIssuanceId.slice(0, 8), 16);
}
