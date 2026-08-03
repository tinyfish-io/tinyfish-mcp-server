/**
 * Phase 5 SSE relay tests over real local HTTP: client → 127.0.0.1 server →
 * proxy core → mock upstream. Covers ordered byte-verbatim relay (raw `data:`
 * payload strings — and the full SSE body — compared on the wire),
 * progressToken preservation (incl. upstream's 'unknown' fill-in),
 * client-abort-mid-stream canceling the upstream request (the mock observes
 * the abort), independent concurrent session streams, mid-stream upstream
 * crash (Phase 6 in-stream error frame), local-write vs upstream error
 * classification at the core level, >64KB SSE frames through the full local
 * server (Phase 7), and shutdown (closeAll via shutdown hooks) aborting an
 * in-flight stream with the framed abort error (Phase 7).
 *
 * The frame-verbatim SSE test formerly in adapter.test.ts moved here.
 */
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { automationCall, listeningPort, postJson, sseDataPayloads } from "./helpers/http.js";
import {
  buildAutomationSseMessages,
  MOCK_RUN_ID,
  startMockUpstream,
  type MockUpstream,
} from "./helpers/mock-upstream.js";
import { LocalWriteError, UpstreamUnreachableError } from "../src/core/errors.js";
import { createProxyCore, type ProxyCore } from "../src/core/proxy-core.js";
import { createMcpAdapter } from "../src/http/adapter.js";
import { createAppHandler, startHttpServer } from "../src/http/index.js";

const API_KEY = "sk-relay-secret-5555";

describe("SSE relay (real local HTTP → mock upstream)", () => {
  let mock: MockUpstream;
  let server: Server;
  let mcpUrl: string;
  let sessionId: string;

  const sessionHeaders = () => ({ "Mcp-Session-Id": sessionId });

  async function initializeSession(id: number): Promise<string> {
    const result = await postJson(mcpUrl, {
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "relay-test", version: "0.0.0" },
      },
    });
    expect(result.status).toBe(200);
    expect(result.sessionId).toBeTruthy();
    return result.sessionId as string;
  }

  beforeAll(async () => {
    mock = await startMockUpstream();
    const core = createProxyCore({ upstreamUrl: mock.url, apiKey: API_KEY, hooks: null });
    server = await startHttpServer(0, createAppHandler(createMcpAdapter(core)));
    mcpUrl = `http://127.0.0.1:${listeningPort(server)}/mcp`;
    sessionId = await initializeSession(1);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await mock.close();
  });

  it("relays the ordered sequence with byte-identical raw data payloads; no session header", async () => {
    const result = await postJson(mcpUrl, automationCall(4, {}, "tok-relay"), sessionHeaders());
    expect(result.status).toBe(200);
    expect(result.contentType).toContain("text/event-stream");
    // Upstream's SSE path sets no Mcp-Session-Id; neither may the proxy.
    expect(result.sessionId).toBeNull();
    const expected = buildAutomationSseMessages("tok-relay", 4);
    // Raw data: payload strings on the wire, in order, final frame last.
    expect(sseDataPayloads(result.text)).toEqual(expected.map((m) => JSON.stringify(m)));
    // Stronger (Phase 7 wire-bytes bar): the ENTIRE raw SSE body received on
    // the socket is byte-identical to what the mock wrote — framing included,
    // no re-parse anywhere in this comparison.
    expect(result.text).toBe(expected.map((m) => `data: ${JSON.stringify(m)}\n\n`).join(""));
  });

  it("preserves upstream's 'unknown' progressToken when the client sent none", async () => {
    const result = await postJson(mcpUrl, automationCall(5, {}), sessionHeaders());
    expect(result.status).toBe(200);
    const payloads = sseDataPayloads(result.text);
    const expected = buildAutomationSseMessages(undefined, 5);
    expect(payloads).toEqual(expected.map((m) => JSON.stringify(m)));
    // The fill-in token really is the literal string 'unknown', relayed untouched.
    const first = JSON.parse(payloads[0]) as { params: { progressToken: unknown } };
    expect(first.params.progressToken).toBe("unknown");
  });

  it("aborts the upstream request when the local client disconnects mid-stream", async () => {
    const seenBefore = mock.seen.length;
    const abort = new AbortController();
    const response = await fetch(mcpUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...sessionHeaders() },
      body: JSON.stringify(automationCall(6, { frameDelayMs: 400 }, "tok-abort")),
      signal: abort.signal,
    });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    // Read the first relayed frame, then drop the connection mid-stream.
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    abort.abort();

    // The mock must OBSERVE the abort — the proxy tore the upstream request
    // down; nothing is orphaned waiting on the remaining scripted frames.
    await vi.waitFor(
      () => {
        const call = mock.seen[seenBefore];
        expect(call?.method).toBe("tools/call");
        expect(call?.aborted).toBe(true);
      },
      { timeout: 3000 }
    );

    // The proxy is still healthy afterwards.
    const ping = await postJson(mcpUrl, { jsonrpc: "2.0", id: 7, method: "ping" });
    expect(ping.status).toBe(200);
  });

  it("streams two concurrent sessions independently", async () => {
    const otherSession = await initializeSession(10);
    expect(otherSession).not.toBe(sessionId);

    const [a, b] = await Promise.all([
      postJson(mcpUrl, automationCall(11, {}, "tok-A"), { "Mcp-Session-Id": sessionId }),
      postJson(mcpUrl, automationCall(12, {}, "tok-B"), { "Mcp-Session-Id": otherSession }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(sseDataPayloads(a.text)).toEqual(
      buildAutomationSseMessages("tok-A", 11).map((m) => JSON.stringify(m))
    );
    expect(sseDataPayloads(b.text)).toEqual(
      buildAutomationSseMessages("tok-B", 12).map((m) => JSON.stringify(m))
    );
  });

  it("PINNED: a no-progress SSE stream (first frame is final) downgrades to a plain JSON response", async () => {
    // Phase 7 review gap 1: when upstream's stream carries ONLY the final
    // JSON-RPC response (no progress frames first), `streaming` never flips in
    // relayPossiblyStreaming, so the adapter answers the tools/call as an
    // ordinary application/json response instead of opening an SSE stream —
    // the documented degenerate-stream behavior in src/http/adapter.ts.
    // Real upstream always emits progress first; this test pins the fallback.
    const result = await postJson(
      mcpUrl,
      automationCall(15, { noProgress: true }, "tok-noprog"),
      sessionHeaders()
    );
    expect(result.status).toBe(200);
    expect(result.contentType).toContain("application/json");
    expect(result.contentType).not.toContain("text/event-stream");
    // No session header either: the core's SSE path reports sessionId null.
    expect(result.sessionId).toBeNull();
    const finalMessage = buildAutomationSseMessages("tok-noprog", 15).at(-1);
    // Raw body string: the re-serialized final frame, byte-stable vs fixture.
    expect(result.text).toBe(JSON.stringify(finalMessage));
  });

  it("emits the Phase 6 in-stream error frame when upstream dies mid-stream", async () => {
    // The mock destroys the socket after 2 frames; the local client must see
    // the 2 relayed frames plus an SSE-framed error — never an unframed body,
    // never a silent clean end. Phase 6 shape: -32000, "run may still be
    // executing", runId (seen in progress _meta) in data. Full payload
    // assertions live in tests/errors.test.ts.
    const result = await postJson(
      mcpUrl,
      automationCall(20, { crashAfterFrames: 2 }, "tok-crash"),
      sessionHeaders()
    );
    expect(result.status).toBe(200);
    expect(result.contentType).toContain("text/event-stream");
    const payloads = sseDataPayloads(result.text);
    const expected = buildAutomationSseMessages("tok-crash", 20);
    expect(payloads).toHaveLength(3);
    expect(payloads.slice(0, 2)).toEqual(expected.slice(0, 2).map((m) => JSON.stringify(m)));
    const errorFrame = JSON.parse(payloads[2]) as {
      jsonrpc: string;
      error: { code: number; message: string; data?: { runId?: string } };
      id: unknown;
    };
    expect(errorFrame.jsonrpc).toBe("2.0");
    expect(errorFrame.error.code).toBe(-32000);
    expect(errorFrame.error.message).toContain("the run may still be executing");
    expect(errorFrame.error.data?.runId).toBe(MOCK_RUN_ID);
    expect(errorFrame.id).toBe(20);

    // The proxy survives the upstream crash.
    const ping = await postJson(mcpUrl, { jsonrpc: "2.0", id: 21, method: "ping" });
    expect(ping.status).toBe(200);
  });
});

describe("raw byte relay fidelity (odd-bytes upstream)", () => {
  it("relays non-canonical upstream payload bytes verbatim (no re-serialization)", async () => {
    // JSON.stringify(JSON.parse(x)) would normalize this spacing away — only
    // a true raw relay reproduces it on the local wire.
    const oddProgress =
      '{ "jsonrpc" : "2.0" , "method" : "notifications/progress" , ' +
      '"params" : { "progressToken" : "tok-raw" , "progress" : 1 , "total" : 100 , "message" : "odd  spacing" } }';
    const oddFinal = '{ "jsonrpc" : "2.0" , "id" : 7 , "result" : { "ok" : true } }';
    const upstream = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: ${oddProgress}\n\n`);
        res.write(`data: ${oddFinal}\n\n`);
        res.end();
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const core = createProxyCore({
      upstreamUrl: `http://127.0.0.1:${listeningPort(upstream)}/mcp`,
      apiKey: API_KEY,
      hooks: null,
    });
    const server = await startHttpServer(0, createAppHandler(createMcpAdapter(core)));
    try {
      const result = await postJson(
        `http://127.0.0.1:${listeningPort(server)}/mcp`,
        automationCall(7, {}, "tok-raw"),
        { "Mcp-Session-Id": "raw-session" }
      );
      expect(result.status).toBe(200);
      expect(result.contentType).toContain("text/event-stream");
      expect(sseDataPayloads(result.text)).toEqual([oddProgress, oddFinal]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  it("relays a >64KB SSE frame through the FULL local server, byte-identical", async () => {
    // Phase 7 gap-fill: tests/sse.test.ts proves the PARSER survives huge
    // frames; this proves the whole hop does — real sockets on both legs,
    // upstream writing the frame in small chunks so it arrives fragmented.
    const bigPayload = JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: {
        progressToken: "tok-big",
        progress: 1,
        total: 100,
        message: "B".repeat(96 * 1024), // ~96KB payload > the 64KB frame bar
      },
    });
    const finalPayload = JSON.stringify({
      jsonrpc: "2.0",
      id: 8,
      result: { content: [{ type: "text", text: "done" }], isError: false },
    });
    const upstream = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const frame = `data: ${bigPayload}\n\n`;
        // 4KB chunks: the big frame crosses many socket writes.
        for (let i = 0; i < frame.length; i += 4096) {
          res.write(frame.slice(i, i + 4096));
        }
        res.write(`data: ${finalPayload}\n\n`);
        res.end();
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const core = createProxyCore({
      upstreamUrl: `http://127.0.0.1:${listeningPort(upstream)}/mcp`,
      apiKey: API_KEY,
      hooks: null,
    });
    const server = await startHttpServer(0, createAppHandler(createMcpAdapter(core)));
    try {
      const result = await postJson(
        `http://127.0.0.1:${listeningPort(server)}/mcp`,
        automationCall(8, {}, "tok-big"),
        { "Mcp-Session-Id": "big-session" }
      );
      expect(result.status).toBe(200);
      expect(result.contentType).toContain("text/event-stream");
      const payloads = sseDataPayloads(result.text);
      expect(payloads).toHaveLength(2);
      expect(payloads[0].length).toBeGreaterThan(64 * 1024);
      expect(payloads[0]).toBe(bigPayload);
      expect(payloads[1]).toBe(finalPayload);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });
});

describe("shutdown with an in-flight stream (closeAll via shutdown hooks)", () => {
  it("aborts the upstream fetch and ends the client stream with the framed abort error", async () => {
    // Phase 7 gap-fill for "SIGTERM closes cleanly": src/index.ts wires
    // SIGINT/SIGTERM to the shutdownHooks array and createProxyCore registers
    // closeAll() there — running the registered hook IS the signal path minus
    // process.exit. Asserted: the in-flight upstream fetch aborts (the mock
    // observes it) and the local client's stream ends — no hang — with the
    // Phase 6 framed -32000 "proxy aborted the upstream request" error.
    const mock = await startMockUpstream();
    const hooks: Array<() => void | Promise<void>> = [];
    const core = createProxyCore({ upstreamUrl: mock.url, apiKey: API_KEY, hooks });
    expect(hooks).toHaveLength(1); // closeAll registered exactly like production
    const server = await startHttpServer(0, createAppHandler(createMcpAdapter(core)));
    const mcpUrl = `http://127.0.0.1:${listeningPort(server)}/mcp`;
    try {
      const seenBefore = mock.seen.length;
      // Slow frames keep the stream in flight while shutdown runs.
      const response = await fetch(mcpUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Mcp-Session-Id": "shutdown-session" },
        body: JSON.stringify(automationCall(50, { frameDelayMs: 500 }, "tok-shutdown")),
      });
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      // Wait for the first relayed frame so the stream is genuinely mid-flight.
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let text = "";
      const first = await reader.read();
      expect(first.done).toBe(false);
      text += decoder.decode(first.value, { stream: true });

      // Simulate SIGTERM: run the registered shutdown hooks (session closeAll).
      for (const hook of hooks) await hook();

      // The upstream request was aborted — the mock observed the teardown.
      await vi.waitFor(
        () => {
          const call = mock.seen[seenBefore];
          expect(call?.method).toBe("tools/call");
          expect(call?.aborted).toBe(true);
        },
        { timeout: 3000 }
      );

      // The client stream ENDS with the framed abort error as its last frame.
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
      const payloads = sseDataPayloads(text);
      expect(payloads.length).toBeGreaterThanOrEqual(2); // ≥1 progress + the error frame
      const last = JSON.parse(payloads[payloads.length - 1]) as {
        jsonrpc: string;
        error: { code: number; message: string; data?: { runId?: string } };
        id: unknown;
      };
      expect(last.jsonrpc).toBe("2.0");
      expect(last.error.code).toBe(-32000);
      expect(last.error.message).toContain("proxy aborted the upstream request");
      expect(last.error.message).toContain("the run may still be executing");
      expect(last.error.data?.runId).toBe(MOCK_RUN_ID);
      expect(last.id).toBe(50);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await mock.close();
    }
  });
});

describe("relay error classification (core level)", () => {
  let mock: MockUpstream;
  let core: ProxyCore;

  beforeAll(async () => {
    mock = await startMockUpstream();
    core = createProxyCore({ upstreamUrl: mock.url, apiKey: API_KEY, hooks: null });
  });

  afterAll(async () => {
    await mock.close();
  });

  it("surfaces onEvent failures as LocalWriteError, never UpstreamUnreachableError", async () => {
    const seenBefore = mock.seen.length;
    const failure = core.forwardStream(
      "local-write-fail",
      automationCall(30, { frameDelayMs: 200 }, "tok-fail"),
      () => {
        throw new Error("EPIPE: broken pipe (simulated local client socket)");
      }
    );
    await expect(failure).rejects.toBeInstanceOf(LocalWriteError);
    await expect(failure).rejects.not.toBeInstanceOf(UpstreamUnreachableError);
    await failure.catch((err: unknown) => {
      expect((err as Error).message).toContain("Relaying SSE frame to the local client failed");
    });
    // Teardown was clean: the upstream stream was canceled, and the mock saw it.
    await vi.waitFor(
      () => {
        expect(mock.seen[seenBefore]?.aborted).toBe(true);
      },
      { timeout: 3000 }
    );
  });

  it("passes the raw payload string to onEvent alongside the parsed message", async () => {
    const raws: Array<string | undefined> = [];
    const result = await core.forwardStream(
      "raw-arg",
      automationCall(31, {}, "tok-raw-arg"),
      (message, rawData) => {
        expect(rawData).toBe(JSON.stringify(message));
        raws.push(rawData);
      }
    );
    expect(raws).toHaveLength(3);
    const expected = buildAutomationSseMessages("tok-raw-arg", 31);
    expect(raws).toEqual(expected.slice(0, 3).map((m) => JSON.stringify(m)));
    // The final frame's raw payload rides on the ProxyResponse for the adapter.
    expect(result.rawBody).toBe(JSON.stringify(expected[3]));
    expect(result.body).toEqual(expected[3]);
  });
});
