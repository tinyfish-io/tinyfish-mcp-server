import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse } from "./helpers/http.js";
import {
  buildAutomationSseMessages,
  MOCK_INITIALIZE_RESULT,
  MOCK_TOOLS_RESULT,
  startMockUpstream,
  type MockUpstream,
} from "./helpers/mock-upstream.js";
import { UpstreamAbortedError, UpstreamProtocolError } from "../src/core/errors.js";
import { createProxyCore, type ProxyCoreOptions } from "../src/core/proxy-core.js";
import { SessionStore } from "../src/core/session.js";
import type { FetchLike } from "../src/core/upstream.js";

const API_KEY = "sk-session-secret-9876";
const UPSTREAM_URL = "https://upstream.test/mcp";

const INITIALIZE_REQUEST = {
  jsonrpc: "2.0",
  id: 0,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test-client", version: "0.0.1" },
  },
};

const INITIALIZED_NOTIFICATION = { jsonrpc: "2.0", method: "notifications/initialized" };
const TOOLS_LIST_REQUEST = { jsonrpc: "2.0", id: 1, method: "tools/list" };

interface RecordedCall {
  headers: Record<string, string>;
  body: unknown;
  signal: AbortSignal | undefined;
}

/** Injected fetch recording each call; responses come from a queue of factories. */
function scriptedFetch(...responders: Array<(call: RecordedCall) => Response | Promise<Response>>): {
  fetchFn: FetchLike;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchFn = ((_input: string | URL | Request, init?: RequestInit) => {
    const call: RecordedCall = {
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ])
      ),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      signal: init?.signal ?? undefined,
    };
    calls.push(call);
    const responder = responders.shift();
    if (responder === undefined) throw new Error("scriptedFetch: no responder left");
    return Promise.resolve(responder(call));
  }) as FetchLike;
  return { fetchFn, calls };
}

function initializeResponse(sessionId: string): Response {
  return jsonResponse(
    { jsonrpc: "2.0", result: MOCK_INITIALIZE_RESULT, id: 0 },
    { headers: { "mcp-session-id": sessionId } }
  );
}

function sseResponse(text: string): Response {
  return new Response(text, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/** A fetch that never resolves until its signal aborts (for close/abort tests). */
function hangingResponder(): (call: RecordedCall) => Promise<Response> {
  return (call) =>
    new Promise<Response>((_resolve, reject) => {
      call.signal?.addEventListener("abort", () =>
        reject(new DOMException("This operation was aborted", "AbortError"))
      );
    });
}

function makeCore(fetchFn: FetchLike, extra: Partial<ProxyCoreOptions> = {}) {
  return createProxyCore({
    upstreamUrl: UPSTREAM_URL,
    apiKey: API_KEY,
    fetchFn,
    hooks: null,
    ...extra,
  });
}

describe("SessionStore", () => {
  it("creates on first use and returns the same entry after", () => {
    const store = new SessionStore();
    const entry = store.getOrCreate("a");
    expect(store.getOrCreate("a")).toBe(entry);
    expect(store.get("a")).toBe(entry);
    expect(store.size).toBe(1);
  });

  it("tracks in-flight controllers and forgets them on endRequest", () => {
    const store = new SessionStore();
    const controller = store.beginRequest("a");
    expect(store.get("a")?.inflight.has(controller)).toBe(true);
    store.endRequest("a", controller);
    expect(store.get("a")?.inflight.size).toBe(0);
    expect(controller.signal.aborted).toBe(false);
  });

  it("close aborts every in-flight controller and drops the entry", () => {
    const store = new SessionStore();
    const c1 = store.beginRequest("a");
    const c2 = store.beginRequest("a");
    const other = store.beginRequest("b");
    store.close("a");
    expect(c1.signal.aborted).toBe(true);
    expect(c2.signal.aborted).toBe(true);
    expect(other.signal.aborted).toBe(false);
    expect(store.has("a")).toBe(false);
    expect(store.has("b")).toBe(true);
  });

  it("close on an unknown key is a no-op", () => {
    expect(() => new SessionStore().close("nope")).not.toThrow();
  });

  it("alias maps a second key to the same entry", () => {
    const store = new SessionStore();
    const entry = store.getOrCreate("a");
    store.alias("upstream-id", entry);
    expect(store.get("upstream-id")).toBe(entry);
    expect(store.size).toBe(2);
  });

  it("close drops every alias key pointing at the same entry", () => {
    const store = new SessionStore();
    const entry = store.getOrCreate("a");
    store.alias("upstream-id", entry);
    const controller = store.beginRequest("upstream-id");
    store.close("a");
    expect(store.has("a")).toBe(false);
    expect(store.has("upstream-id")).toBe(false);
    expect(controller.signal.aborted).toBe(true);
    expect(store.size).toBe(0);
  });

  it("closeAll aborts and drops every session", () => {
    const store = new SessionStore();
    const c1 = store.beginRequest("a");
    const c2 = store.beginRequest("b");
    store.closeAll();
    expect(c1.signal.aborted).toBe(true);
    expect(c2.signal.aborted).toBe(true);
    expect(store.size).toBe(0);
  });
});

describe("proxyCore session bridging (injected fetch)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("captures Mcp-Session-Id from initialize and replays it on later calls", async () => {
    const { fetchFn, calls } = scriptedFetch(
      () => initializeResponse("sess-abc"),
      () => jsonResponse({ jsonrpc: "2.0", result: MOCK_TOOLS_RESULT, id: 1 })
    );
    const core = makeCore(fetchFn);

    const init = await core.initialize("local-1", INITIALIZE_REQUEST);
    expect(init.sessionId).toBe("sess-abc");
    expect(init.status).toBe(200);
    expect(init.body).toEqual({ jsonrpc: "2.0", result: MOCK_INITIALIZE_RESULT, id: 0 });
    expect(calls[0].headers).not.toHaveProperty("mcp-session-id");

    await core.forward("local-1", TOOLS_LIST_REQUEST);
    expect(calls[1].headers["mcp-session-id"]).toBe("sess-abc");
  });

  it("passes the client protocol version through on initialize and later calls", async () => {
    const { fetchFn, calls } = scriptedFetch(
      () => initializeResponse("sess-pv"),
      () => new Response(null, { status: 204 }),
      () => jsonResponse({ jsonrpc: "2.0", result: {}, id: 2 })
    );
    const core = makeCore(fetchFn);

    await core.initialize("local-1", INITIALIZE_REQUEST, "2025-06-18");
    await core.notify("local-1", INITIALIZED_NOTIFICATION);
    await core.forward("local-1", { jsonrpc: "2.0", id: 2, method: "ping" });

    for (const call of calls) {
      expect(call.headers["mcp-protocol-version"]).toBe("2025-06-18");
    }
  });

  it("aliases the session under the upstream id: calls keyed by it reuse the captured entry", async () => {
    const { fetchFn, calls } = scriptedFetch(
      () => initializeResponse("sess-upstream"),
      () => jsonResponse({ jsonrpc: "2.0", result: MOCK_TOOLS_RESULT, id: 1 })
    );
    const core = makeCore(fetchFn);
    await core.initialize("init-key", INITIALIZE_REQUEST, "2025-06-18");

    // Phase 4 raw-pipe bridging: the client re-sends upstream's id and the
    // adapter keys calls by it — which must resolve to the same session entry.
    await core.forward("sess-upstream", TOOLS_LIST_REQUEST);
    expect(calls[1].headers["mcp-session-id"]).toBe("sess-upstream");
    // The protocol version proves it's the shared entry, not just the localKey fallback.
    expect(calls[1].headers["mcp-protocol-version"]).toBe("2025-06-18");
  });

  it("falls back to sending localKey as Mcp-Session-Id when no id was captured", async () => {
    const { fetchFn, calls } = scriptedFetch(
      () => jsonResponse({ jsonrpc: "2.0", result: MOCK_TOOLS_RESULT, id: 1 }),
      () => new Response(null, { status: 204 })
    );
    const core = makeCore(fetchFn);
    await core.forward("upstream-id-123", TOOLS_LIST_REQUEST);
    await core.notify("upstream-id-123", INITIALIZED_NOTIFICATION);
    expect(calls[0].headers["mcp-session-id"]).toBe("upstream-id-123");
    expect(calls[1].headers["mcp-session-id"]).toBe("upstream-id-123");
  });

  it("initialize never falls back to localKey (upstream must mint the id)", async () => {
    const { fetchFn, calls } = scriptedFetch(() => initializeResponse("sess-minted"));
    await makeCore(fetchFn).initialize("adapter-invented-key", INITIALIZE_REQUEST);
    expect(calls[0].headers).not.toHaveProperty("mcp-session-id");
  });

  it("does not resurrect a session closed while initialize was in flight", async () => {
    let release: ((response: Response) => void) | undefined;
    const { fetchFn, calls } = scriptedFetch(
      () => new Promise<Response>((resolve) => (release = resolve)),
      () => jsonResponse({ jsonrpc: "2.0", result: {}, id: 1 })
    );
    const core = makeCore(fetchFn);
    const pending = core.initialize("local-1", INITIALIZE_REQUEST);
    await vi.waitFor(() => {
      expect(release).toBeDefined();
    });
    core.close("local-1");
    release?.(initializeResponse("sess-late"));

    // The response still flows back to the caller...
    const result = await pending;
    expect(result.sessionId).toBe("sess-late");
    // ...but no entry was recreated or aliased: the next call for the same key
    // falls back to the key itself rather than replaying "sess-late".
    await core.forward("local-1", TOOLS_LIST_REQUEST);
    expect(calls[1].headers["mcp-session-id"]).toBe("local-1");
  });

  it("omits the protocol version header when the client never sent one", async () => {
    const { fetchFn, calls } = scriptedFetch(() => initializeResponse("sess-npv"));
    await makeCore(fetchFn).initialize("local-1", INITIALIZE_REQUEST);
    expect(calls[0].headers).not.toHaveProperty("mcp-protocol-version");
  });

  it("forwards the initialize request body verbatim", async () => {
    const { fetchFn, calls } = scriptedFetch(() => initializeResponse("sess-vb"));
    await makeCore(fetchFn).initialize("local-1", INITIALIZE_REQUEST);
    expect(calls[0].body).toEqual(INITIALIZE_REQUEST);
  });

  it("notify resolves void on 204 and carries the stored session id", async () => {
    const { fetchFn, calls } = scriptedFetch(
      () => initializeResponse("sess-n"),
      () => new Response(null, { status: 204 })
    );
    const core = makeCore(fetchFn);
    await core.initialize("local-1", INITIALIZE_REQUEST);
    await expect(core.notify("local-1", INITIALIZED_NOTIFICATION)).resolves.toBeUndefined();
    expect(calls[1].body).toEqual(INITIALIZED_NOTIFICATION);
    expect(calls[1].headers["mcp-session-id"]).toBe("sess-n");
  });

  it("returns upstream JSON-RPC error objects untouched with their HTTP status", async () => {
    const errorFixture = {
      jsonrpc: "2.0",
      error: { code: -32601, message: "Method not found: prompts/list" },
      id: 9,
    };
    const { fetchFn } = scriptedFetch(() => jsonResponse(errorFixture, { status: 400 }));
    const result = await makeCore(fetchFn).forward("local-1", {
      jsonrpc: "2.0",
      id: 9,
      method: "prompts/list",
    });
    expect(result.status).toBe(400);
    expect(result.body).toEqual(errorFixture);
  });

  it("forward throws UpstreamProtocolError on an unexpected SSE response", async () => {
    const { fetchFn } = scriptedFetch(() => sseResponse(`data: {"jsonrpc":"2.0"}\n\n`));
    await expect(makeCore(fetchFn).forward("local-1", TOOLS_LIST_REQUEST)).rejects.toBeInstanceOf(
      UpstreamProtocolError
    );
  });

  it("initialize throws UpstreamProtocolError on an unexpected SSE response", async () => {
    const { fetchFn } = scriptedFetch(() => sseResponse(`data: {"jsonrpc":"2.0"}\n\n`));
    await expect(
      makeCore(fetchFn).initialize("local-1", INITIALIZE_REQUEST)
    ).rejects.toBeInstanceOf(UpstreamProtocolError);
  });

  it("initialize throws UpstreamProtocolError on an unexpected empty response", async () => {
    const { fetchFn } = scriptedFetch(() => new Response(null, { status: 204 }));
    await expect(
      makeCore(fetchFn).initialize("local-1", INITIALIZE_REQUEST)
    ).rejects.toBeInstanceOf(UpstreamProtocolError);
  });

  it("close aborts an in-flight fetch and forgets the session", async () => {
    const { fetchFn, calls } = scriptedFetch(
      () => initializeResponse("sess-x"),
      hangingResponder(),
      () => jsonResponse({ jsonrpc: "2.0", result: {}, id: 3 })
    );
    const core = makeCore(fetchFn);
    await core.initialize("local-1", INITIALIZE_REQUEST);

    const pending = core.forward("local-1", TOOLS_LIST_REQUEST);
    // Let the fetch start before closing.
    await new Promise((resolve) => setImmediate(resolve));
    core.close("local-1");

    await expect(pending).rejects.toBeInstanceOf(UpstreamAbortedError);
    expect(calls[1].signal?.aborted).toBe(true);

    // The mapping is gone: the next call for the same key no longer carries the
    // captured "sess-x" — it falls back to replaying the key itself.
    await core.forward("local-1", { jsonrpc: "2.0", id: 3, method: "ping" });
    expect(calls[2].headers["mcp-session-id"]).toBe("local-1");
  });

  it("registers session cleanup in the provided shutdown hooks array", async () => {
    const hooks: Array<() => void | Promise<void>> = [];
    const { fetchFn, calls } = scriptedFetch(hangingResponder());
    const core = makeCore(fetchFn, { hooks });
    expect(hooks).toHaveLength(1);

    const pending = core.forward("local-1", TOOLS_LIST_REQUEST);
    await new Promise((resolve) => setImmediate(resolve));
    await hooks[0]();

    await expect(pending).rejects.toBeInstanceOf(UpstreamAbortedError);
    expect(calls[0].signal?.aborted).toBe(true);
  });

  it("never writes the API key to stderr (including the notify warning path)", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const { fetchFn } = scriptedFetch(
      () => initializeResponse("sess-log"),
      // Non-204 answer to a notification triggers the core's only log line.
      () => jsonResponse({ jsonrpc: "2.0", error: { code: -32000, message: "nope" }, id: -1 }, { status: 401 })
    );
    const core = makeCore(fetchFn);
    await core.initialize("local-1", INITIALIZE_REQUEST);
    await core.notify("local-1", INITIALIZED_NOTIFICATION);
    core.close("local-1");

    const written = stderrSpy.mock.calls.map((args) => String(args[0])).join("");
    // Phase 6 pinned decision: the JSON answer is dropped (notifications have
    // no response channel) but the warn names both status and error code.
    expect(written).toContain("unexpected json response (HTTP 401, JSON-RPC error -32000)");
    expect(written).not.toContain(API_KEY);
  });
});

describe("proxyCore forwardStream", () => {
  const CALL_REQUEST = {
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: {
      name: "run_web_automation",
      arguments: { goal: "test" },
      _meta: { progressToken: "tok-1" },
    },
  };

  it("resolves plain JSON responses directly without calling onEvent", async () => {
    const body = { jsonrpc: "2.0", result: { content: [], isError: false }, id: 5 };
    const { fetchFn } = scriptedFetch(() =>
      jsonResponse(body, { headers: { "mcp-session-id": "sess-j" } })
    );
    const onEvent = vi.fn();
    const result = await makeCore(fetchFn).forwardStream("local-1", CALL_REQUEST, onEvent);
    expect(result).toEqual({
      status: 200,
      body,
      sessionId: "sess-j",
      contentType: "application/json",
    });
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("emits SSE notification frames via onEvent and resolves the final response", async () => {
    const messages = buildAutomationSseMessages("tok-1", 5);
    const text = messages.map((m) => `data: ${JSON.stringify(m)}\n\n`).join("");
    const { fetchFn } = scriptedFetch(() => sseResponse(text));

    const events: unknown[] = [];
    const result = await makeCore(fetchFn).forwardStream("local-1", CALL_REQUEST, (m) => {
      events.push(m);
    });

    expect(events).toEqual(messages.slice(0, 3));
    expect(result.body).toEqual(messages[3]);
    expect(result.status).toBe(200);
    // Upstream SSE responses carry no Mcp-Session-Id header.
    expect(result.sessionId).toBeNull();
  });

  it("handles SSE frames split across arbitrary chunk boundaries", async () => {
    const messages = buildAutomationSseMessages(undefined, 5);
    const text = messages.map((m) => `data: ${JSON.stringify(m)}\n\n`).join("");
    // Slice into awkward 7-byte chunks so frames straddle chunk boundaries.
    const bytes = new TextEncoder().encode(text);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 7) {
          controller.enqueue(bytes.slice(i, i + 7));
        }
        controller.close();
      },
    });
    const { fetchFn } = scriptedFetch(
      () =>
        new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })
    );

    const events: unknown[] = [];
    const result = await makeCore(fetchFn).forwardStream("local-1", CALL_REQUEST, (m) => {
      events.push(m);
    });
    expect(events).toEqual(messages.slice(0, 3));
    expect(result.body).toEqual(messages[3]);
  });

  it("awaits each async onEvent emission before processing the next frame", async () => {
    const messages = buildAutomationSseMessages("tok-1", 5);
    const text = messages.map((m) => `data: ${JSON.stringify(m)}\n\n`).join("");
    const { fetchFn } = scriptedFetch(() => sseResponse(text));

    const order: string[] = [];
    let n = 0;
    const result = await makeCore(fetchFn).forwardStream("local-1", CALL_REQUEST, async () => {
      const i = ++n;
      order.push(`start-${i}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(`end-${i}`);
    });

    expect(order).toEqual(["start-1", "end-1", "start-2", "end-2", "start-3", "end-3"]);
    expect(result.body).toEqual(messages[3]);
  });

  it("stops reading at the final frame: post-final frames never reach onEvent, stream canceled", async () => {
    const messages = buildAutomationSseMessages("tok-1", 5);
    const postFinal = {
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: {
        progressToken: "tok-1",
        progress: 99,
        total: 100,
        message: "spec-violating frame after the final response",
      },
    };
    let canceled = false;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const message of [...messages, postFinal]) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(message)}\n\n`));
        }
        // Never closes — resolution proves the reader stops at the final frame
        // instead of waiting for upstream to end the stream.
      },
      cancel() {
        canceled = true;
      },
    });
    const { fetchFn } = scriptedFetch(
      () =>
        new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })
    );

    const events: unknown[] = [];
    const result = await makeCore(fetchFn).forwardStream("local-1", CALL_REQUEST, (m) => {
      events.push(m);
    });
    expect(events).toEqual(messages.slice(0, 3));
    expect(result.body).toEqual(messages[3]);
    expect(canceled).toBe(true);
  });

  it("throws UpstreamProtocolError when the stream ends without a final response", async () => {
    const notification = {
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: { progressToken: "tok-1", progress: 0, total: 100, message: "started" },
    };
    const { fetchFn } = scriptedFetch(() =>
      sseResponse(`data: ${JSON.stringify(notification)}\n\n`)
    );
    await expect(
      makeCore(fetchFn).forwardStream("local-1", CALL_REQUEST, () => {})
    ).rejects.toBeInstanceOf(UpstreamProtocolError);
  });

  it("aborts an in-flight SSE stream on close", async () => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        controller.enqueue(
          new TextEncoder().encode(
            `data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progressToken":"tok-1","progress":0,"total":100,"message":"started"}}\n\n`
          )
        );
        // Never closes — the stream hangs until the fetch signal aborts.
      },
    });
    const { fetchFn, calls } = scriptedFetch((call) => {
      // Mimic fetch: aborting the signal errors the response body stream.
      call.signal?.addEventListener("abort", () => {
        streamController?.error(new DOMException("This operation was aborted", "AbortError"));
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });

    const core = makeCore(fetchFn);
    const events: unknown[] = [];
    const pending = core.forwardStream("local-1", CALL_REQUEST, (m) => {
        events.push(m);
      });
    // Wait until the first frame arrived, then tear the session down.
    await vi.waitFor(() => {
      expect(events).toHaveLength(1);
    });
    core.close("local-1");

    await expect(pending).rejects.toBeInstanceOf(UpstreamAbortedError);
    expect(calls[0].signal?.aborted).toBe(true);
  });
});

describe("proxyCore against the real mock upstream (HTTP hop)", () => {
  let mock: MockUpstream | undefined;

  afterEach(async () => {
    await mock?.close();
    mock = undefined;
  });

  it("runs a full conversation: initialize, notify, list, error, streaming call", async () => {
    mock = await startMockUpstream();
    const core = createProxyCore({
      upstreamUrl: mock.url,
      apiKey: "sk-e2e-key",
      hooks: null,
    });

    // initialize — upstream mints the session id; core captures it.
    const init = await core.initialize("local-e2e", INITIALIZE_REQUEST, "2025-06-18");
    expect(init.status).toBe(200);
    expect(init.sessionId).toBeTruthy();
    expect(init.body).toEqual({ jsonrpc: "2.0", result: MOCK_INITIALIZE_RESULT, id: 0 });
    const sessionId = init.sessionId;

    // notification → 204 → resolves; session id was replayed.
    await expect(core.notify("local-e2e", INITIALIZED_NOTIFICATION)).resolves.toBeUndefined();

    // tools/list replays the captured session id (mock records what it saw).
    const list = await core.forward("local-e2e", TOOLS_LIST_REQUEST);
    expect(list.status).toBe(200);
    expect(list.body).toEqual({ jsonrpc: "2.0", result: MOCK_TOOLS_RESULT, id: 1 });

    // unknown method → HTTP 400 with the error object verbatim.
    const unknown = await core.forward("local-e2e", {
      jsonrpc: "2.0",
      id: 2,
      method: "prompts/list",
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body).toEqual({
      jsonrpc: "2.0",
      error: { code: -32601, message: "Method not found: prompts/list" },
      id: 2,
    });

    // streaming tools/call: 3 progress notifications in order, then the final frame.
    const events: unknown[] = [];
    const call = await core.forwardStream(
      "local-e2e",
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "run_web_automation",
          arguments: { goal: "extract" },
          _meta: { progressToken: "tok-e2e" },
        },
      },
      (m) => {
        events.push(m);
      }
    );
    const expected = buildAutomationSseMessages("tok-e2e", 3);
    expect(events).toEqual(expected.slice(0, 3));
    expect(call.body).toEqual(expected[3]);
    expect(call.status).toBe(200);
    expect(call.sessionId).toBeNull();

    // Every non-notification request after initialize carried the same session id.
    expect(mock.seen.map((s) => s.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "prompts/list",
      "tools/call",
    ]);
    for (const entry of mock.seen.slice(1)) {
      expect(entry.sessionId).toBe(sessionId);
    }

    core.close("local-e2e");
  });
});
