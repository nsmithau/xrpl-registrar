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
