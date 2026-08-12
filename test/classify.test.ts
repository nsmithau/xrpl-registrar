import { describe, expect, it } from "vitest";

import { classifyError } from "../src/clio/classify.js";

import { namedError, xrpldError } from "./helpers.js";

describe("classifyError", () => {
  it("marks load-shed xrpld errors as retryable", () => {
    for (const code of ["slowDown", "tooBusy", "noNetwork"]) {
      expect(classifyError(xrpldError(code))).toEqual({ code, retryable: true });
    }
  });

  it("marks request-level xrpld errors as non-retryable", () => {
    for (const code of ["actNotFound", "invalidParams", "unknownCmd"]) {
      expect(classifyError(xrpldError(code))).toEqual({ code, retryable: false });
    }
  });

  it("treats connection-level failures as retryable load signals", () => {
    expect(classifyError(namedError("DisconnectedError"))).toEqual({
      code: "DisconnectedError",
      retryable: true,
    });
    expect(classifyError(namedError("TimeoutError"))).toEqual({
      code: "TimeoutError",
      retryable: true,
    });
  });

  it("returns non-retryable for unknown or non-error inputs", () => {
    expect(classifyError(new Error("boom"))).toEqual({ code: "Error", retryable: false });
    expect(classifyError(null)).toEqual({ code: undefined, retryable: false });
    expect(classifyError("nope")).toEqual({ code: undefined, retryable: false });
  });
});
