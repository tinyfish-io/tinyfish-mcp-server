import { createServer } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse } from "./helpers/http.js";
import {
  UpstreamAbortedError,
  UpstreamProtocolError,
  UpstreamUnreachableError,
} from "../src/core/errors.js";
import { UpstreamClient, type FetchLike } from "../src/core/upstream.js";
import { VERSION } from "../src/version.js";

const API_KEY = "sk-unit-secret-0123";
const URL_UNDER_TEST = "https://upstream.test/mcp";

const PING = { jsonrpc: "2.0", id: 1, method: "ping" };

interface RecordedCall {
  url: string;
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal | undefined;
}

/** Injected fetch that records every call and replies from a response factory. */
function recordingFetch(respond: (call: RecordedCall) => Response | Promise<Response>): {
  fetchFn: FetchLike;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchFn = ((input: string | URL | Request, init?: RequestInit) => {
    const call: RecordedCall = {
      url: String(input),
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ])
      ),
      body: typeof init?.body === "string" ? init.body : "",
      signal: init?.signal ?? undefined,
    };
    calls.push(call);
    return Promise.resolve(respond(call));
  }) as FetchLike;
  return { fetchFn, calls };
}

function makeClient(fetchFn: FetchLike, clientVersion?: string): UpstreamClient {
  return new UpstreamClient({ url: URL_UNDER_TEST, apiKey: API_KEY, clientVersion, fetchFn });
}

describe("UpstreamClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("outbound headers", () => {
    it("sends the full header set on every call", async () => {
      const { fetchFn, calls } = recordingFetch(() => jsonResponse({ jsonrpc: "2.0", result: {}, id: 1 }));
      const client = makeClient(fetchFn, "1.2.3");

      await client.post(PING);
      await client.post(PING, { sessionId: "sess-1" });

      expect(calls).toHaveLength(2);
      for (const call of calls) {
        expect(call.url).toBe(URL_UNDER_TEST);
        expect(call.headers["content-type"]).toBe("application/json");
        expect(call.headers["accept"]).toBe("application/json, text/event-stream");
        expect(call.headers["x-api-key"]).toBe(API_KEY);
        expect(call.headers["x-tf-request-origin"]).toBe("tinyfish-mcp");
        expect(call.headers["x-tf-client-name"]).toBe("tinyfish-mcp");
        expect(call.headers["x-tf-client-version"]).toBe("1.2.3");
      }
    });

    it("defaults X-TF-Client-Version to the package version", async () => {
      const { fetchFn, calls } = recordingFetch(() => jsonResponse({ jsonrpc: "2.0", result: {}, id: 1 }));
      await makeClient(fetchFn).post(PING);
      expect(calls[0].headers["x-tf-client-version"]).toBe(VERSION);
    });

    it("omits Mcp-Session-Id and MCP-Protocol-Version when not provided", async () => {
      const { fetchFn, calls } = recordingFetch(() => jsonResponse({ jsonrpc: "2.0", result: {}, id: 1 }));
      await makeClient(fetchFn).post(PING);
      expect(calls[0].headers).not.toHaveProperty("mcp-session-id");
      expect(calls[0].headers).not.toHaveProperty("mcp-protocol-version");
    });

    it("sends Mcp-Session-Id and MCP-Protocol-Version when provided", async () => {
      const { fetchFn, calls } = recordingFetch(() => jsonResponse({ jsonrpc: "2.0", result: {}, id: 1 }));
      await makeClient(fetchFn).post(PING, {
        sessionId: "sess-42",
        protocolVersion: "2025-06-18",
      });
      expect(calls[0].headers["mcp-session-id"]).toBe("sess-42");
      expect(calls[0].headers["mcp-protocol-version"]).toBe("2025-06-18");
    });

    it("serializes the JSON-RPC message as the POST body", async () => {
      const { fetchFn, calls } = recordingFetch(() => jsonResponse({ jsonrpc: "2.0", result: {}, id: 1 }));
      await makeClient(fetchFn).post(PING);
      expect(JSON.parse(calls[0].body)).toEqual(PING);
    });
  });

  describe("response classification", () => {
    it("classifies a JSON response with session header", async () => {
      const body = { jsonrpc: "2.0", result: { ok: true }, id: 7 };
      const { fetchFn } = recordingFetch(() =>
        jsonResponse(body, { headers: { "mcp-session-id": "sess-json" } })
      );
      const response = await makeClient(fetchFn).post(PING);
      expect(response).toEqual({
        kind: "json",
        status: 200,
        sessionId: "sess-json",
        body,
        contentType: "application/json",
      });
    });

    it("classifies a JSON response without session header (sessionId null)", async () => {
      const { fetchFn } = recordingFetch(() => jsonResponse({ jsonrpc: "2.0", result: {}, id: 1 }));
      const response = await makeClient(fetchFn).post(PING);
      expect(response.kind).toBe("json");
      if (response.kind === "json") expect(response.sessionId).toBeNull();
    });

    it("preserves upstream HTTP status on JSON-RPC error responses", async () => {
      const errorBody = {
        jsonrpc: "2.0",
        error: { code: -32601, message: "Method not found: prompts/list" },
        id: 3,
      };
      const { fetchFn } = recordingFetch(() => jsonResponse(errorBody, { status: 400 }));
      const response = await makeClient(fetchFn).post(PING);
      expect(response).toEqual({
        kind: "json",
        status: 400,
        sessionId: null,
        body: errorBody,
        contentType: "application/json",
      });
    });

    it("classifies 204 as empty (notification path)", async () => {
      const { fetchFn } = recordingFetch(() => new Response(null, { status: 204 }));
      const response = await makeClient(fetchFn).post({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      });
      expect(response).toEqual({ kind: "empty", status: 204 });
    });

    it("classifies an empty 200 body as empty", async () => {
      const { fetchFn } = recordingFetch(() => new Response("", { status: 200 }));
      const response = await makeClient(fetchFn).post(PING);
      expect(response).toEqual({ kind: "empty", status: 200 });
    });

    it("classifies text/event-stream as sse with the raw stream", async () => {
      const frame = `data: {"jsonrpc":"2.0","result":{},"id":1}\n\n`;
      const { fetchFn } = recordingFetch(
        () =>
          new Response(frame, {
            status: 200,
            headers: { "content-type": "text/event-stream; charset=utf-8" },
          })
      );
      const response = await makeClient(fetchFn).post(PING);
      expect(response.kind).toBe("sse");
      if (response.kind === "sse") {
        expect(response.status).toBe(200);
        expect(await new Response(response.stream).text()).toBe(frame);
      }
    });

    it("throws UpstreamProtocolError on a non-JSON body, carrying the status", async () => {
      const { fetchFn } = recordingFetch(
        () =>
          new Response("<html>gateway error</html>", {
            status: 502,
            headers: { "content-type": "text/html" },
          })
      );
      const promise = makeClient(fetchFn).post(PING);
      await expect(promise).rejects.toBeInstanceOf(UpstreamProtocolError);
      await promise.catch((err: UpstreamProtocolError) => {
        expect(err.status).toBe(502);
        expect(err.message).not.toContain(API_KEY);
      });
    });
  });

  describe("transport failures", () => {
    it("throws UpstreamUnreachableError on connection refused (real fetch, closed port)", async () => {
      // Grab a loopback port and close it again so nothing is listening.
      const port = await new Promise<number>((resolve) => {
        const srv = createServer();
        srv.listen(0, "127.0.0.1", () => {
          const address = srv.address();
          const p = typeof address === "object" && address !== null ? address.port : 0;
          srv.close(() => resolve(p));
        });
      });
      const client = new UpstreamClient({
        url: `http://127.0.0.1:${port}/mcp`,
        apiKey: API_KEY,
      });
      const promise = client.post(PING);
      await expect(promise).rejects.toBeInstanceOf(UpstreamUnreachableError);
      await promise.catch((err: Error) => {
        // The actionable errno from err.cause is surfaced in the message.
        expect(err.message).toContain("ECONNREFUSED");
        expect(err.message).not.toContain(API_KEY);
        expect(String(err)).not.toContain(API_KEY);
      });
    });

    it("throws UpstreamAbortedError when the signal aborts the fetch", async () => {
      const fetchFn = ((_input: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("This operation was aborted", "AbortError"))
          );
        })) as FetchLike;
      const controller = new AbortController();
      const promise = makeClient(fetchFn).post(PING, { signal: controller.signal });
      controller.abort();
      await expect(promise).rejects.toBeInstanceOf(UpstreamAbortedError);
    });
  });

  it("never writes the API key to stderr", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const { fetchFn } = recordingFetch(() => jsonResponse({ jsonrpc: "2.0", result: {}, id: 1 }));
    const client = makeClient(fetchFn);
    await client.post(PING);
    await client.post(PING, { sessionId: "sess-1", protocolVersion: "2025-06-18" });
    const written = stderrSpy.mock.calls.map((args) => String(args[0])).join("");
    expect(written).not.toContain(API_KEY);
  });
});
