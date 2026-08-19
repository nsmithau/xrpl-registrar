import { convertStringToHex } from "xrpl";

import { hexToBytes } from "../util/hex.js";

/**
 * Normalise an XRPL currency code to its human string.
 *
 * Standard codes are 3 ASCII characters. Codes longer than 3 characters (e.g.
 * `RLUSD`) are carried on the wire as a 40-hex-char (20-byte) value, ASCII with
 * trailing NUL padding. This returns the readable form either way, so callers
 * can compare against a plain string like `"RLUSD"`.
 */
export function currencyToString(code: string): string {
  if (code.length === 3) return code;
  if (/^[0-9A-Fa-f]{40}$/.test(code)) {
    const bytes = hexToBytes(code);
    let out = "";
    for (const b of bytes) {
      if (b === 0) break;
      out += String.fromCharCode(b);
    }
    return out || code;
  }
  return code;
}

/**
 * The on-wire currency representation, as Clio/`xrpld` return it: a 3-character
 * standard code as-is (`USD`), and any longer (non-standard) readable code as
 * its 40-hex (20-byte) ASCII form, right-padded with zeros (`FUSD` →
 * `4655534400…00`). The inverse of {@link currencyToString} for the readable
 * codes this archive stores — used where a response must match Clio's shape
 * exactly (e.g. `gateway_balances` obligations keys).
 */
export function currencyToWire(code: string): string {
  if (code.length === 3) return code;
  return convertStringToHex(code).toUpperCase().padEnd(40, "0");
}

/**
 * Normalise an operator-supplied IOU currency for storage.
 *
 * Accepts either the readable code (`RLUSD`, `USD`) or the 40-hex on-wire form
 * (`524C55…`) and returns the readable code the archive compares ledger data
 * against — so a pasted hex still matches. Throws on an empty, over-long, or
 * reserved (`XRP`) code, so a bad registration fails loudly at the door instead
 * of silently matching nothing during discovery.
 */
export function normalizeCurrency(input: string): string {
  const code = currencyToString(input.trim());
  if (code === "") throw new Error("currency is required");
  if (code === "XRP") throw new Error("XRP is not an issuable IOU currency");
  // Readable non-standard codes decode to at most 20 characters; anything
  // longer is not a currency code (e.g. a mistyped issuance id).
  if (code.length > 20)
    throw new Error(`currency '${code}' is not a valid currency code (max 20 characters)`);
  return code;
}
