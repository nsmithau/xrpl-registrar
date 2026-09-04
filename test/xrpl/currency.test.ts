import { describe, expect, it } from "vitest";

import { currencyToString, currencyToWire, normalizeCurrency } from "../../src/xrpl/currency.js";

// "TOKEN" as the 40-hex on-wire form (ASCII + trailing NUL padding).
const TOKEN_HEX = "544F4B454E000000000000000000000000000000";

describe("currencyToString", () => {
  it("passes standard 3-char codes through unchanged", () => {
    expect(currencyToString("USD")).toBe("USD");
  });

  it("decodes a 40-hex non-standard code to its readable form", () => {
    expect(currencyToString(TOKEN_HEX)).toBe("TOKEN");
  });

  it("leaves an already-readable non-standard code unchanged", () => {
    expect(currencyToString("TOKEN")).toBe("TOKEN");
  });
});

describe("currencyToWire", () => {
  it("passes standard 3-char codes through unchanged", () => {
    expect(currencyToWire("USD")).toBe("USD");
  });

  it("encodes a non-standard code as its 40-hex on-wire form", () => {
    expect(currencyToWire("TOKEN")).toBe(TOKEN_HEX);
    expect(currencyToWire("FUSD")).toBe("4655534400000000000000000000000000000000");
  });

  it("round-trips with currencyToString", () => {
    expect(currencyToString(currencyToWire("TOKEN"))).toBe("TOKEN");
  });
});

describe("normalizeCurrency", () => {
  it("accepts a readable code as-is", () => {
    expect(normalizeCurrency("TOKEN")).toBe("TOKEN");
    expect(normalizeCurrency("USD")).toBe("USD");
  });

  it("normalizes the 40-hex on-wire form to the readable code", () => {
    expect(normalizeCurrency(TOKEN_HEX)).toBe("TOKEN");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeCurrency("  TOKEN  ")).toBe("TOKEN");
  });

  it("rejects an empty code", () => {
    expect(() => normalizeCurrency("")).toThrow(/required/);
    expect(() => normalizeCurrency("   ")).toThrow(/required/);
  });

  it("rejects XRP (not an issuable IOU)", () => {
    expect(() => normalizeCurrency("XRP")).toThrow(/XRP/);
  });

  it("rejects an over-long value (e.g. a mistyped issuance id)", () => {
    expect(() => normalizeCurrency("000000011515151515151515151515151515151515151515")).toThrow(
      /valid currency code/,
    );
  });
});
