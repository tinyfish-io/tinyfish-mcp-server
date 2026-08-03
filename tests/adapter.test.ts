/**
 * Full-flow tests for the HTTP adapter over real local HTTP against the spike
 * mock upstream: client → 127.0.0.1 server → proxy core → mock upstream.
 *
 * Tests inside the main describe run sequentially and share one session
 * (initialize captures the upstream-issued Mcp-Session-Id; later requests
 * re-send it, exercising the raw-pipe session bridging end to end).
 */
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listeningPort, postJson, send } from "./helpers/http.js";
import {
  buildEchoResult,
  buildResourceReadResult,
  MOCK_INITIALIZE_RESULT,
  MOCK_RESOURCES_RESULT,
  MOCK_TOOLS_RESULT,
  startMockUpstream,
  type MockUpstream,
} from "./helpers/mock-upstream.js";
import { createProxyCore } from "../src/core/proxy-core.js";
import { createMcpAdapter } from "../src/http/adapter.js";
import { createAppHandler, startHttpServer, type RequestHandler } from "../src/http/index.js";

const API_KEY = "sk-adapter-secret-0000";

describe("HTTP adapter full flow (real local HTTP → mock upstream)", () => {
  let mock: MockUpstream;
  let server: Server;
  let base: string;
  let mcpUrl: string;
  // Captured at initialize; re-sent by the "client" afterwards (raw-pipe bridging).
  let sessionId: string;
  const sessionHeaders = () => ({
    "Mcp-Session-Id": sessionId,
    "MCP-Protocol-Version": "2025-11-25",
  });

  beforeAll(async () => {
    mock = await startMockUpstream();
    const core = createProxyCore({
      upstreamUrl: mock.url,
      apiKey: API_KEY,
      hooks: null,
    });
    server = await startHttpServer(0, createAppHandler(createMcpAdapter(core)));
    base = `http://127.0.0.1:${listeningPort(server)}`;
    mcpUrl = `${base}/mcp`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await mock.close();
  });

  it("initialize: upstream body verbatim, status 200, Mcp-Session-Id echoed", async () => {
    const result = await postJson(mcpUrl, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "adapter-test", version: "0.0.0" },
      },
    });
    expect(result.status).toBe(200);
    expect(result.contentType).toContain("application/json");
    // Byte-verbatim: the proxy re-serializes JSON.parse output, which is
    // byte-stable (key order preserved) — compare raw text.
    expect(result.text).toBe(
      JSON.stringify({ jsonrpc: "2.0", result: MOCK_INITIALIZE_RESULT, id: 1 })
    );
    expect(result.sessionId).toBeTruthy();
    // The echoed id is the upstream-issued one, not something local.
    expect(result.sessionId).toBe(mock.seen.at(-1)?.sessionId);
    sessionId = result.sessionId as string;
  });

  it("re-initialize with a client-sent session id replays it upstream (proxy-restart case)", async () => {
    // A client re-initializing with an id the proxy never saw (e.g. after a
    // proxy restart) must have that id reach upstream — real upstream adopts
    // client-sent header ids on initialize instead of minting a fresh one.
    const restoredId = "restored-after-proxy-restart";
    const result = await postJson(
      mcpUrl,
      {
        jsonrpc: "2.0",
        id: 90,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t" } },
      },
      { "Mcp-Session-Id": restoredId }
    );
    expect(result.status).toBe(200);
    expect(mock.seen.at(-1)).toMatchObject({ method: "initialize", sessionId: restoredId });
    // Upstream (and therefore the proxy) echoes the adopted id back.
    expect(result.sessionId).toBe(restoredId);
  });

  it("notifications/initialized: 204 empty; session id reaches upstream", async () => {
    const result = await postJson(
      mcpUrl,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      sessionHeaders()
    );
    expect(result.status).toBe(204);
    expect(result.text).toBe("");
    expect(mock.seen.at(-1)).toMatchObject({
      method: "notifications/initialized",
      sessionId,
    });
  });

  it("tools/list: body verbatim vs fixture; upstream session id echoed back", async () => {
    const result = await postJson(
      mcpUrl,
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      sessionHeaders()
    );
    expect(result.status).toBe(200);
    expect(result.text).toBe(JSON.stringify({ jsonrpc: "2.0", result: MOCK_TOOLS_RESULT, id: 2 }));
    expect(result.sessionId).toBe(sessionId);
    expect(mock.seen.at(-1)).toMatchObject({ method: "tools/list", sessionId });
  });

  it("tools/call (non-streaming echo): JSON body verbatim with upstream status", async () => {
    const args = { text: "hello adapter", n: 42 };
    const request = {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "echo", arguments: args },
    };
    const result = await postJson(mcpUrl, request, sessionHeaders());
    expect(result.status).toBe(200);
    expect(result.contentType).toContain("application/json");
    expect(result.text).toBe(
      JSON.stringify({ jsonrpc: "2.0", result: buildEchoResult("echo", args), id: 3 })
    );
    expect(result.sessionId).toBe(sessionId);
    // The request body reached upstream verbatim over the real socket — the
    // mock records the parsed body per request (Phase 7 review gap 3).
    expect(mock.seen.at(-1)?.body).toEqual(request);
  });

  it("resources/list forwards generically: raw body verbatim vs fixture (Phase 7 — spike never exercised resources/*)", async () => {
    const result = await postJson(
      mcpUrl,
      { jsonrpc: "2.0", id: 40, method: "resources/list", params: {} },
      sessionHeaders()
    );
    expect(result.status).toBe(200);
    expect(result.contentType).toContain("application/json");
    // Raw body string comparison — the wire-bytes bar, not a deep-equal.
    expect(result.text).toBe(
      JSON.stringify({ jsonrpc: "2.0", result: MOCK_RESOURCES_RESULT, id: 40 })
    );
    expect(mock.seen.at(-1)).toMatchObject({ method: "resources/list", sessionId });
  });

  it("resources/read forwards the uri param and relays the contents verbatim", async () => {
    const uri = "tinyfish://mock/readme";
    const result = await postJson(
      mcpUrl,
      { jsonrpc: "2.0", id: 41, method: "resources/read", params: { uri } },
      sessionHeaders()
    );
    expect(result.status).toBe(200);
    expect(result.text).toBe(
      JSON.stringify({ jsonrpc: "2.0", result: buildResourceReadResult(uri), id: 41 })
    );
    expect(mock.seen.at(-1)).toMatchObject({ method: "resources/read", sessionId });
  });

  // The SSE streaming test moved to tests/relay.test.ts (Phase 5) — the relay
  // suite owns all streaming coverage; no duplicate here.

  it("unknown method: upstream MethodNotFound relayed verbatim with upstream 400", async () => {
    const result = await postJson(
      mcpUrl,
      { jsonrpc: "2.0", id: 5, method: "prompts/list", params: {} },
      sessionHeaders()
    );
    expect(result.status).toBe(400);
    expect(result.text).toBe(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32601, message: "Method not found: prompts/list" },
        id: 5,
      })
    );
  });

  it("ping without a session works (no invented Mcp-Session-Id sent upstream)", async () => {
    const result = await postJson(mcpUrl, { jsonrpc: "2.0", id: 6, method: "ping" });
    expect(result.status).toBe(200);
    expect(JSON.parse(result.text)).toEqual({ jsonrpc: "2.0", result: {}, id: 6 });
    expect(mock.seen.at(-1)).toMatchObject({ method: "ping", sessionId: null });
  });

  it("inbound Authorization header is ignored and never reaches upstream", async () => {
    const before = mock.seen.length;
    const result = await postJson(
      mcpUrl,
      { jsonrpc: "2.0", id: 7, method: "tools/list", params: {} },
      { ...sessionHeaders(), Authorization: "Bearer stolen-credential" }
    );
    expect(result.status).toBe(200);
    expect(mock.seen.length).toBe(before + 1);
    expect(mock.seen.at(-1)).toMatchObject({ method: "tools/list", authorization: null });
  });

  it("malformed JSON body: local ParseError -32700, HTTP 400, id -1; nothing forwarded", async () => {
    const before = mock.seen.length;
    const result = await send(mcpUrl, {
      body: "{ not json",
      headers: { "Content-Type": "application/json" },
    });
    expect(result.status).toBe(400);
    expect(JSON.parse(result.text)).toEqual({
      jsonrpc: "2.0",
      error: { code: -32700, message: "Parse error: Invalid JSON" },
      id: -1,
    });
    expect(mock.seen.length).toBe(before);
  });

  it("non-/mcp paths are 404", async () => {
    const getRoot = await send(`${base}/`, { method: "GET" });
    expect(getRoot.status).toBe(404);
    const postOther = await postJson(`${base}/other`, { jsonrpc: "2.0", id: 8, method: "ping" });
    expect(postOther.status).toBe(404);
  });

  it("non-POST /mcp mirrors upstream: 405 with Allow: POST", async () => {
    for (const method of ["GET", "DELETE"]) {
      const result = await send(mcpUrl, { method });
      expect(result.status).toBe(405);
      expect(result.headers.get("allow")).toBe("POST");
    }
  });

  it("GET /healthz answers 200 ok", async () => {
    const result = await send(`${base}/healthz`, { method: "GET" });
    expect(result.status).toBe(200);
    expect(result.text).toBe("ok");
  });

  it("evil Origin: 403 plain text before proxying (mock sees nothing)", async () => {
    const before = mock.seen.length;
    const result = await postJson(
      mcpUrl,
      { jsonrpc: "2.0", id: 9, method: "ping" },
      { Origin: "https://evil.example.com" }
    );
    expect(result.status).toBe(403);
    expect(result.contentType).toContain("text/plain");
    expect(mock.seen.length).toBe(before);
  });

  it("loopback Origin is allowed through", async () => {
    const result = await postJson(
      mcpUrl,
      { jsonrpc: "2.0", id: 10, method: "ping" },
      { Origin: "http://localhost:6274" } // MCP Inspector's default origin
    );
    expect(result.status).toBe(200);
  });

  it("client MCP-Protocol-Version header is forwarded per request", async () => {
    const result = await postJson(
      mcpUrl,
      { jsonrpc: "2.0", id: 11, method: "ping" },
      { "MCP-Protocol-Version": "2025-11-25" }
    );
    expect(result.status).toBe(200);
    expect(mock.seen.at(-1)).toMatchObject({ method: "ping", protocolVersion: "2025-11-25" });
  });

  it("MCP-Protocol-Version is absent upstream when the client did not send one", async () => {
    const result = await postJson(mcpUrl, { jsonrpc: "2.0", id: 12, method: "ping" });
    expect(result.status).toBe(200);
    expect(mock.seen.at(-1)).toMatchObject({ method: "ping", protocolVersion: null });
  });
});

describe("ping before initialize (fresh server, no session anywhere)", () => {
  it("forwards a header-less ping before any initialize happened (upstream allows it)", async () => {
    // Phase 7 gap-fill: the main suite pings AFTER its initialize ran; this
    // proves the very first request a client ever sends can be a ping — no
    // session header, no prior state — and it round-trips.
    const mock = await startMockUpstream();
    const core = createProxyCore({ upstreamUrl: mock.url, apiKey: API_KEY, hooks: null });
    const server = await startHttpServer(0, createAppHandler(createMcpAdapter(core)));
    try {
      const result = await postJson(`http://127.0.0.1:${listeningPort(server)}/mcp`, {
        jsonrpc: "2.0",
        id: 1,
        method: "ping",
      });
      expect(result.status).toBe(200);
      // Raw body string — upstream's answer verbatim.
      expect(result.text).toBe(JSON.stringify({ jsonrpc: "2.0", result: {}, id: 1 }));
      expect(mock.seen).toHaveLength(1);
      expect(mock.seen[0]).toMatchObject({ method: "ping", sessionId: null });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await mock.close();
    }
  });
});

describe("unhandled adapter failures (async-safe RequestHandler seam)", () => {
  it("async handler rejection becomes a 500 JSON-RPC InternalError, not a swallow", async () => {
    const rejecting: RequestHandler = async () => {
      await Promise.resolve();
      throw new Error("boom (contains no secrets)");
    };
    const server = await startHttpServer(0, rejecting);
    try {
      const result = await send(`http://127.0.0.1:${listeningPort(server)}/anything`, {
        method: "POST",
        body: "{}",
      });
      expect(result.status).toBe(500);
      expect(JSON.parse(result.text)).toEqual({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal error" },
        id: null,
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("unreachable upstream: shaped -32000 'cannot reach' error (Phase 6), no key leak", async () => {
    const core = createProxyCore({
      // A loopback port with nothing listening — fetch fails fast.
      upstreamUrl: "http://127.0.0.1:9/mcp",
      apiKey: "sk-never-leaked-1234",
      hooks: null,
    });
    const server = await startHttpServer(0, createAppHandler(createMcpAdapter(core)));
    try {
      const result = await postJson(`http://127.0.0.1:${listeningPort(server)}/mcp`, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x" } },
      });
      expect(result.status).toBe(502);
      expect(JSON.parse(result.text)).toEqual({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message:
            "cannot reach 127.0.0.1:9 — check your network; " +
            "the hosted MCP server may also be temporarily unavailable",
        },
        id: 1,
      });
      expect(result.text).not.toContain("sk-never-leaked-1234");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
