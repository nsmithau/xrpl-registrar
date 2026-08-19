import { describe, expect, it } from "vitest";

import { currencyToString, currencyToWire, normalizeCurrency } from "../../src/xrpl/currency.js";

// "RLUSD" as the 40-hex on-wire form (ASCII + trailing NUL padding).
const RLUSD_HEX = "524C555344000000000000000000000000000000";

describe("currencyToString", () => {
  it("passes standard 3-char codes through unchanged", () => {
    expect(currencyToString("USD")).toBe("USD");
  });

  it("decodes a 40-hex non-standard code to its readable form", () => {
    expect(currencyToString(RLUSD_HEX)).toBe("RLUSD");
  });

  it("leaves an already-readable non-standard code unchanged", () => {
    expect(currencyToString("RLUSD")).toBe("RLUSD");
  });
});

describe("currencyToWire", () => {
  it("passes standard 3-char codes through unchanged", () => {
    expect(currencyToWire("USD")).toBe("USD");
  });

  it("encodes a non-standard code as its 40-hex on-wire form", () => {
    expect(currencyToWire("RLUSD")).toBe(RLUSD_HEX);
    expect(currencyToWire("FUSD")).toBe("4655534400000000000000000000000000000000");
  });

  it("round-trips with currencyToString", () => {
    expect(currencyToString(currencyToWire("RLUSD"))).toBe("RLUSD");
  });
});

describe("normalizeCurrency", () => {
  it("accepts a readable code as-is", () => {
    expect(normalizeCurrency("RLUSD")).toBe("RLUSD");
    expect(normalizeCurrency("USD")).toBe("USD");
  });

  it("normalizes the 40-hex on-wire form to the readable code", () => {
    expect(normalizeCurrency(RLUSD_HEX)).toBe("RLUSD");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeCurrency("  RLUSD  ")).toBe("RLUSD");
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
