/**
 * Error-handling tests — one test per error-shaping rule, exercised through
 * the FULL local HTTP hop (client → 127.0.0.1 proxy → mock upstream) unless
 * the rule is unreachable over real sockets (the final-frame write race uses
 * a stub ServerResponse).
 *
 * Rules:
 *  1. Upstream JSON-RPC error (any code)      → forwarded byte-verbatim.
 *  2. Upstream 401/403, non-JSON-RPC body     → -32001 + TINYFISH_API_KEY hint.
 *  3. Upstream 4xx/5xx with JSON-RPC body     → rule 1 (verbatim, status kept).
 *  4. Upstream unreachable                    → -32000 "cannot reach <host>",
 *                                               never silently retried.
 *  5. Mid-stream SSE disconnect               → framed -32000, "run may still
 *                                               be executing", runId in data
 *                                               when seen in progress _meta.
 *  6. Local proxy bug                         → -32603 generic, stack to stderr.
 *  +  Malformed client JSON                   → -32700, id -1, HTTP 400.
 *  +  Final-frame write failure classifies as LOCAL.
 *
 * Locally shaped upstream-leg errors (-32000/-32001) answer HTTP 502; local
 * bugs answer 500; ParseError answers 400 (decision documented in
 * src/core/errors.ts).
 */
import { EventEmitter } from "node:events";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { automationCall, listeningPort, postJson, sseDataPayloads } from "./helpers/http.js";
import { MOCK_RUN_ID, startMockUpstream, type MockUpstream } from "./helpers/mock-upstream.js";
import {
  AUTH_BODY_LIMIT,
  toStreamErrorFrame,
  UpstreamAbortedError,
  UpstreamUnreachableError,
} from "../src/core/errors.js";
import { createProxyCore, type ProxyCore } from "../src/core/proxy-core.js";
import { createMcpAdapter } from "../src/http/adapter.js";
import { createAppHandler, startHttpServer } from "../src/http/index.js";
import { log } from "../src/log.js";

const API_KEY = "sk-errors-secret-7777";

interface JsonRpcErrorShape {
  jsonrpc: string;
  error: { code: number; message: string; data?: Record<string, unknown> };
  id: unknown;
}

describe("error-shaping rules (full local HTTP hop → mock upstream)", () => {
  let mock: MockUpstream;
  let server: Server;
  let mcpUrl: string;
  let sessionId: string;

  beforeAll(async () => {
    mock = await startMockUpstream();
    const core = createProxyCore({ upstreamUrl: mock.url, apiKey: API_KEY, hooks: null });
    server = await startHttpServer(0, createAppHandler(createMcpAdapter(core)));
    mcpUrl = `http://127.0.0.1:${listeningPort(server)}/mcp`;
    const init = await fetch(mcpUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t" } },
      }),
    });
    sessionId = init.headers.get("mcp-session-id") as string;
    await init.text();
    expect(sessionId).toBeTruthy();
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await mock.close();
  });

  afterEach(() => {
    mock.authReject = null;
    vi.restoreAllMocks();
  });

  const sessionHeaders = () => ({ "Mcp-Session-Id": sessionId });

  it("row 1: upstream JSON-RPC error forwards byte-verbatim under upstream's HTTP status", async () => {
    const result = await postJson(
      mcpUrl,
      { jsonrpc: "2.0", id: 3, method: "prompts/list", params: {} },
      sessionHeaders()
    );
    // Upstream maps MethodNotFound to HTTP 400 — preserved, body raw-text-equal.
    expect(result.status).toBe(400);
    expect(result.text).toBe(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32601, message: "Method not found: prompts/list" },
        id: 3,
      })
    );
  });

  it("row 3: upstream 401 with a JSON-RPC error body forwards verbatim, 401 preserved (never -32001)", async () => {
    // Error body includes data — every field must survive untouched.
    const upstreamBody = JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Invalid API key. Generate a new one at https://app.tinyfish.ai",
        data: { docs: "https://docs.tinyfish.ai/auth", run_hint: null },
      },
      id: 4,
    });
    mock.authReject = { status: 401, contentType: "application/json", body: upstreamBody };
    const result = await postJson(
      mcpUrl,
      { jsonrpc: "2.0", id: 4, method: "tools/list", params: {} },
      sessionHeaders()
    );
    expect(result.status).toBe(401);
    expect(result.text).toBe(upstreamBody);
  });

  it("row 2: upstream 401 with a text body shapes -32001, TINYFISH_API_KEY hint, HTTP 502", async () => {
    mock.authReject = {
      status: 401,
      contentType: "text/plain",
      body: "Unauthorized: no valid credential presented (mock gateway)",
    };
    const result = await postJson(
      mcpUrl,
      { jsonrpc: "2.0", id: 5, method: "tools/list", params: {} },
      sessionHeaders()
    );
    expect(result.status).toBe(502);
    const parsed = JSON.parse(result.text) as JsonRpcErrorShape;
    expect(parsed.error.code).toBe(-32001);
    expect(parsed.error.message).toContain("TINYFISH_API_KEY");
    expect(parsed.error.data).toEqual({
      upstreamStatus: 401,
      upstreamBody: "Unauthorized: no valid credential presented (mock gateway)",
    });
    expect(parsed.id).toBe(5);
    expect(result.text).not.toContain(API_KEY);
  });

  it("row 2: upstream 403 with a huge HTML body truncates upstreamBody to ~2KB", async () => {
    const hugeBody = `<html><body>Forbidden</body></html>${"x".repeat(5000)}`;
    mock.authReject = { status: 403, contentType: "text/html", body: hugeBody };
    const result = await postJson(
      mcpUrl,
      { jsonrpc: "2.0", id: 6, method: "tools/list", params: {} },
      sessionHeaders()
    );
    expect(result.status).toBe(502);
    const parsed = JSON.parse(result.text) as JsonRpcErrorShape;
    expect(parsed.error.code).toBe(-32001);
    expect(parsed.error.data?.upstreamStatus).toBe(403);
    expect(parsed.error.data?.upstreamBody).toBe(hugeBody.slice(0, AUTH_BODY_LIMIT));
    expect((parsed.error.data?.upstreamBody as string).length).toBe(AUTH_BODY_LIMIT);
  });

  it("row 2: upstream 401 with a JSON but non-JSON-RPC body also shapes -32001", async () => {
    mock.authReject = {
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ error: "unauthorized", hint: "not a JSON-RPC message" }),
    };
    const result = await postJson(
      mcpUrl,
      { jsonrpc: "2.0", id: 7, method: "tools/list", params: {} },
      sessionHeaders()
    );
    expect(result.status).toBe(502);
    const parsed = JSON.parse(result.text) as JsonRpcErrorShape;
    expect(parsed.error.code).toBe(-32001);
    expect(parsed.error.data?.upstreamStatus).toBe(401);
  });

  it("row 2: upstream 401 with an EMPTY body still shapes -32001 (not a generic empty/protocol error)", async () => {
    // Gateways and LBs strip bodies; the check-your-key hint must survive.
    mock.authReject = { status: 401, contentType: "text/plain", body: "" };
    const result = await postJson(
      mcpUrl,
      { jsonrpc: "2.0", id: 12, method: "tools/list", params: {} },
      sessionHeaders()
    );
    expect(result.status).toBe(502);
    const parsed = JSON.parse(result.text) as JsonRpcErrorShape;
    expect(parsed.error.code).toBe(-32001);
    expect(parsed.error.message).toContain("TINYFISH_API_KEY");
    expect(parsed.error.data).toEqual({ upstreamStatus: 401, upstreamBody: "" });
    expect(parsed.id).toBe(12);
  });

  it("row 2: 401 with quasi-JSON-RPC junk (jsonrpc marker, no error/result/method) shapes -32001", async () => {
    const junk = JSON.stringify({ jsonrpc: "2.0", message: "unauthorized" });
    mock.authReject = { status: 401, contentType: "application/json", body: junk };
    const result = await postJson(
      mcpUrl,
      { jsonrpc: "2.0", id: 13, method: "tools/list", params: {} },
      sessionHeaders()
    );
    // Not a JSON-RPC message → NOT forwarded verbatim; shaped as auth error.
    expect(result.status).toBe(502);
    const parsed = JSON.parse(result.text) as JsonRpcErrorShape;
    expect(parsed.error.code).toBe(-32001);
    expect(parsed.error.data).toEqual({ upstreamStatus: 401, upstreamBody: junk });
  });

  it("notification hitting a 401 non-JSON-RPC body: HTTP 502, -32001, id null (never a silent 204)", async () => {
    // The THROWING notification error
    // path through the wire. The auth failure throws before the adapter's
    // writeHead(204), so the shaped -32001 replaces the 204 wholesale, with
    // id null (notifications carry no id). Contrast: a 401 whose body IS a
    // JSON-RPC error is swallowed after a warn (deliberate, covered at
    // core level in tests/session.test.ts).
    mock.authReject = {
      status: 401,
      contentType: "text/plain",
      body: "Unauthorized (mock gateway, non-JSON-RPC body)",
    };
    const result = await postJson(
      mcpUrl,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      sessionHeaders()
    );
    expect(result.status).toBe(502);
    const parsed = JSON.parse(result.text) as JsonRpcErrorShape;
    expect(parsed.error.code).toBe(-32001);
    expect(parsed.error.message).toContain("TINYFISH_API_KEY");
    expect(parsed.error.data).toEqual({
      upstreamStatus: 401,
      upstreamBody: "Unauthorized (mock gateway, non-JSON-RPC body)",
    });
    expect(parsed.id).toBeNull();
    expect(result.text).not.toContain(API_KEY);
  });

  it("row 5: mid-stream disconnect emits framed -32000 with runId from progress _meta", async () => {
    // Frames 0-1 carry _meta.runId; the mock kills the socket after 2 frames.
    const result = await postJson(mcpUrl, automationCall(20, { crashAfterFrames: 2 }, "tok-20"), {
      ...sessionHeaders(),
    });
    expect(result.status).toBe(200);
    expect(result.contentType).toContain("text/event-stream");
    const payloads = sseDataPayloads(result.text);
    expect(payloads).toHaveLength(3);
    const frame = JSON.parse(payloads[2]) as JsonRpcErrorShape;
    expect(frame.jsonrpc).toBe("2.0");
    expect(frame.error.code).toBe(-32000);
    expect(frame.error.message).toContain("the run may still be executing");
    expect(frame.error.data).toEqual({ runId: MOCK_RUN_ID });
    // Recovery guidance names the run id, mirroring upstream's convention.
    expect(frame.error.message).toContain(MOCK_RUN_ID);
    expect(frame.id).toBe(20);
  });

  it("row 5: mid-stream disconnect with no runId seen omits data entirely", async () => {
    const result = await postJson(
      mcpUrl,
      automationCall(21, { crashAfterFrames: 2, omitRunMeta: true }, "tok-21"),
      sessionHeaders()
    );
    expect(result.status).toBe(200);
    const payloads = sseDataPayloads(result.text);
    expect(payloads).toHaveLength(3);
    const frame = JSON.parse(payloads[2]) as JsonRpcErrorShape;
    expect(frame.error.code).toBe(-32000);
    expect(frame.error.message).toContain("the run may still be executing");
    expect("data" in frame.error).toBe(false);
    expect(frame.id).toBe(21);
  });

  it("malformed client JSON: local ParseError -32700, id -1, HTTP 400", async () => {
    const before = mock.seen.length;
    const response = await fetch(mcpUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"jsonrpc": "2.0", "id": 8, "method": ', // truncated JSON
    });
    expect(response.status).toBe(400);
    expect(JSON.parse(await response.text())).toEqual({
      jsonrpc: "2.0",
      error: { code: -32700, message: "Parse error: Invalid JSON" },
      id: -1,
    });
    // The proxy answered without forwarding — it cannot route what it cannot parse.
    expect(mock.seen.length).toBe(before);
  });
});

describe("row 4: upstream unreachable", () => {
  it("shapes -32000 'cannot reach <host>' at HTTP 502 and never retries silently", async () => {
    // A TCP server that destroys every accepted socket: fetch fails after
    // connecting, and the connection count proves there was no silent retry
    // (a tools/call may have side effects).
    let connections = 0;
    const deadUpstream = createNetServer((socket) => {
      connections += 1;
      socket.destroy();
    });
    await new Promise<void>((resolve) => deadUpstream.listen(0, "127.0.0.1", resolve));
    const port = (deadUpstream.address() as AddressInfo).port;

    const core = createProxyCore({
      upstreamUrl: `http://127.0.0.1:${port}/mcp`,
      apiKey: API_KEY,
      hooks: null,
    });
    const server = await startHttpServer(0, createAppHandler(createMcpAdapter(core)));
    try {
      const result = await postJson(`http://127.0.0.1:${listeningPort(server)}/mcp`, {
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: { name: "echo", arguments: { text: "side-effectful" } },
      });
      expect(result.status).toBe(502);
      expect(JSON.parse(result.text)).toEqual({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message:
            `cannot reach 127.0.0.1:${port} — check your network; ` +
            `the hosted MCP server may also be temporarily unavailable`,
        },
        id: 9,
      });
      expect(result.text).not.toContain(API_KEY);
      // Exactly one upstream attempt — never retried silently.
      expect(connections).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => deadUpstream.close(() => resolve()));
    }
  });
});

describe("row 6: local proxy bug", () => {
  it("answers generic -32603 at HTTP 500 with the stack on stderr, never the detail", async () => {
    const boom = new TypeError("boom: simulated proxy bug (internal detail)");
    const buggyCore: ProxyCore = {
      initialize: () => Promise.reject(boom),
      notify: () => Promise.reject(boom),
      forward: () => Promise.reject(boom),
      forwardStream: () => Promise.reject(boom),
      close: () => undefined,
      closeAll: () => undefined,
    };
    const errorSpy = vi.spyOn(log, "error").mockImplementation(() => undefined);
    const server = await startHttpServer(0, createAppHandler(createMcpAdapter(buggyCore)));
    try {
      const result = await postJson(`http://127.0.0.1:${listeningPort(server)}/mcp`, {
        jsonrpc: "2.0",
        id: 42,
        method: "tools/list",
        params: {},
      });
      expect(result.status).toBe(500);
      expect(JSON.parse(result.text)).toEqual({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal error" },
        id: 42,
      });
      // The client never sees the internal detail...
      expect(result.text).not.toContain("boom");
      // ...but stderr gets the full stack.
      const logged = errorSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(logged).toContain("boom: simulated proxy bug");
      expect(logged).toContain("at "); // stack frames present
    } finally {
      vi.restoreAllMocks();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("toStreamErrorFrame differentiates failure kinds", () => {
  it("gives a session-close abort its own message, distinct from an upstream death", () => {
    const aborted = toStreamErrorFrame(new UpstreamAbortedError("aborted"), 1, MOCK_RUN_ID);
    const died = toStreamErrorFrame(new UpstreamUnreachableError("terminated"), 1, MOCK_RUN_ID);
    expect(aborted.error.code).toBe(-32000);
    expect(died.error.code).toBe(-32000);
    expect(aborted.error.message).not.toBe(died.error.message);
    expect(aborted.error.message).toContain("proxy aborted the upstream request");
    expect(died.error.message).toContain("Upstream stream ended unexpectedly");
    // Both keep the recovery guidance — a live run could be left behind.
    expect(aborted.error.message).toContain("the run may still be executing");
    expect(died.error.message).toContain("the run may still be executing");
    expect(aborted.error.data).toEqual({ runId: MOCK_RUN_ID });
    expect(died.error.data).toEqual({ runId: MOCK_RUN_ID });
  });

  it("shapes a local bug mid-stream as generic -32603, keeping the runId handle", () => {
    const frame = toStreamErrorFrame(new TypeError("boom internals"), 2, MOCK_RUN_ID);
    expect(frame.error.code).toBe(-32603);
    expect(frame.error.message).not.toContain("boom");
    expect(frame.error.data).toEqual({ runId: MOCK_RUN_ID });
    expect(frame.id).toBe(2);
  });
});

describe("final-frame write failure classifies as LOCAL", () => {
  /**
   * Stub ServerResponse whose write() succeeds for the progress frames and
   * fails on the final frame, WITHOUT emitting 'close' first — the narrow
   * race where the socket dies between the last progress write and the final
   * write. The failure must be classified as a local write failure (logged as
   * such, socket destroyed), never as "upstream stream failed mid-relay".
   */
  class FinalWriteFailingResponse extends EventEmitter {
    headersSent = false;
    writableEnded = false;
    destroyed = false;
    writes = 0;
    constructor(private readonly failAfterWrites: number) {
      super();
    }
    writeHead(): this {
      this.headersSent = true;
      return this;
    }
    write(_chunk: unknown, cb?: (err?: Error | null) => void): boolean {
      this.writes += 1;
      if (this.writes > this.failAfterWrites) {
        cb?.(new Error("EPIPE: simulated local socket death on the final frame"));
        return false;
      }
      cb?.();
      return true;
    }
    end(): this {
      this.writableEnded = true;
      return this;
    }
    destroy(): this {
      this.destroyed = true;
      return this;
    }
  }

  function fakeRequest(body: unknown): IncomingMessage {
    const req = Readable.from([
      Buffer.from(JSON.stringify(body)),
    ]) as unknown as IncomingMessage;
    (req as { headers: Record<string, string> }).headers = {
      "mcp-session-id": "gap2-session",
    };
    return req;
  }

  it("logs the LocalWriteError and destroys the socket; never 'upstream failed mid-relay'", async () => {
    const mock = await startMockUpstream();
    const core = createProxyCore({ upstreamUrl: mock.url, apiKey: API_KEY, hooks: null });
    const handler = createMcpAdapter(core);
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(log, "error").mockImplementation(() => undefined);
    try {
      // 3 progress frames succeed; write #4 (the final frame) fails.
      const res = new FinalWriteFailingResponse(3);
      await handler(fakeRequest(automationCall(30, {}, "tok-30")), res as unknown as ServerResponse);

      expect(res.writes).toBe(4); // 3 progress + the failed final write
      expect(res.destroyed).toBe(true);
      expect(res.writableEnded).toBe(false);

      const warned = warnSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(warned).toContain("Relaying the final SSE frame to the local client failed");
      const errored = errorSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(errored).not.toContain("upstream stream failed mid-relay");
      expect(errored).not.toContain("Upstream unreachable");
    } finally {
      vi.restoreAllMocks();
      await mock.close();
    }
  });
});
