import { afterEach, describe, expect, it, vi } from "vitest";

import { classifyError } from "../src/clio/classify.js";
import { HttpTransport } from "../src/clio/httpTransport.js";

/** Build a minimal fetch Response stand-in. */
function fakeResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
  } as unknown as Response;
}

const transport = new HttpTransport("https://clio.example:51234/");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("HttpTransport", () => {
  it("posts JSON-RPC { method, params:[args] } and returns result/warnings/forwarded", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      fakeResponse(200, {
        result: { status: "success", transactions: [], marker: { ledger: 5, seq: 0 } },
        warnings: [{ id: 2001, message: "clio" }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const raw = await transport.request({
      command: "account_tx",
      account: "rX",
      api_version: 2,
      marker: { m: 1 },
    });

    // Request shape: command → method; everything else → params[0].
    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe("https://clio.example:51234/");
    expect(JSON.parse(call[1]!.body as string)).toEqual({
      method: "account_tx",
      params: [{ account: "rX", api_version: 2, marker: { m: 1 } }],
    });
    // Response passthrough.
    expect(raw.result.marker).toEqual({ ledger: 5, seq: 0 });
    expect(raw.warnings).toEqual([{ id: 2001, message: "clio" }]);
    expect(raw.forwarded).toBeUndefined();
  });

  it("throws a JSON-RPC error body as an xrpld-style error (classifier decides retryability)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fakeResponse(200, { result: { status: "error", error: "actNotFound" } })),
    );
    const err = await transport
      .request({ command: "account_tx", account: "rX" })
      .catch((e: unknown) => e);
    expect(classifyError(err)).toEqual({ code: "actNotFound", retryable: false });
  });

  it("treats a slowDown error body as a retryable load signal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fakeResponse(200, { result: { status: "error", error: "slowDown" } })),
    );
    const err = await transport.request({ command: "server_info" }).catch((e: unknown) => e);
    expect(classifyError(err)).toEqual({ code: "slowDown", retryable: true });
  });

  it("treats HTTP 503 as retryable and captures Retry-After", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fakeResponse(503, "busy", { "retry-after": "2" })),
    );
    const err = (await transport.request({ command: "server_info" }).catch((e: unknown) => e)) as {
      httpStatus?: number;
      retryAfter?: string;
    };
    expect(err.httpStatus).toBe(503);
    expect(err.retryAfter).toBe("2");
    expect(classifyError(err)).toEqual({ code: "HTTP_503", retryable: true });
  });

  it("treats a non-2xx client error as non-retryable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fakeResponse(400, "bad")),
    );
    const err = await transport.request({ command: "server_info" }).catch((e: unknown) => e);
    expect(classifyError(err)).toEqual({ code: "HTTP_400", retryable: false });
  });

  it("is stateless: connect/disconnect are no-ops and it reports connected", async () => {
    await transport.connect();
    await transport.disconnect();
    expect(transport.isConnected()).toBe(true);
  });
});
