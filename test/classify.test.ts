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

  it("treats a bare Error whose message signals a transport failure as retryable", () => {
    // A disconnect often throws a typed error first, then a plain Error on the
    // retry while the socket reconnects — recognise the latter by message.
    expect(classifyError(new Error("websocket connection closed"))).toEqual({
      code: "Error",
      retryable: true,
    });
    expect(classifyError(new Error("not connected"))).toEqual({ code: "Error", retryable: true });
    expect(classifyError(new Error("socket hang up"))).toEqual({ code: "Error", retryable: true });
  });

  it("classifies HTTP transport status codes: 429/5xx are load, others are not", () => {
    expect(classifyError({ httpStatus: 429 })).toEqual({ code: "HTTP_429", retryable: true });
    expect(classifyError({ httpStatus: 503 })).toEqual({ code: "HTTP_503", retryable: true });
    expect(classifyError({ httpStatus: 500 })).toEqual({ code: "HTTP_500", retryable: true });
    expect(classifyError({ httpStatus: 400 })).toEqual({ code: "HTTP_400", retryable: false });
    expect(classifyError({ httpStatus: 404 })).toEqual({ code: "HTTP_404", retryable: false });
  });

  it("reads a fetch network failure through TypeError('fetch failed') and its cause", () => {
    // Node's fetch wraps socket errors: the outer error is a TypeError with the
    // real failure on `cause`. Both shapes must be retryable, or one dropped HTTP
    // connection fails a whole resumable backfill sweep.
    const reset = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
    });
    expect(classifyError(reset)).toEqual({ code: "ECONNRESET", retryable: true });
    // undici's own codes, with a message that says nothing on its own — the
    // specific inner code is what gets reported.
    const undici = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
    });
    expect(classifyError(undici)).toEqual({ code: "UND_ERR_SOCKET", retryable: true });
    // A bare system error with a code and no recognisable message.
    expect(classifyError(Object.assign(new Error("x"), { code: "ETIMEDOUT" }))).toEqual({
      code: "ETIMEDOUT",
      retryable: true,
    });
    // `fetch failed` with an unrecognised cause is still a network failure
    // (fetch throws it for nothing else), so it stays retryable.
    const opaque = Object.assign(new TypeError("fetch failed"), { cause: new Error("boom") });
    expect(classifyError(opaque)).toEqual({ code: "TypeError", retryable: true });
  });

  it("returns non-retryable for unknown or non-error inputs", () => {
    expect(classifyError(new Error("boom"))).toEqual({ code: "Error", retryable: false });
    expect(classifyError(null)).toEqual({ code: undefined, retryable: false });
    expect(classifyError("nope")).toEqual({ code: undefined, retryable: false });
  });
});
