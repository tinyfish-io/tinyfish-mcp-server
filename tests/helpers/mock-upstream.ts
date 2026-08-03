/**
 * Mock of the hosted https://agent.tinyfish.ai/mcp endpoint — the single
 * fixture shared by every test suite. Faithful to the hosted server's
 * verified behavior:
 *
 * - POST-only (anything else gets 405, like Next.js's missing-export handling).
 * - initialize with no Mcp-Session-Id header generates a UUID; successful JSON
 *   responses echo Mcp-Session-Id but the SSE path does not (it sets only
 *   stream headers). Session ids are NOT validated (any non-empty string is
 *   accepted).
 * - Non-ping requests without the header get JSON-RPC -32600
 *   "Missing required Mcp-Session-Id header" (HTTP 400 — the hosted server
 *   maps client-error codes to HTTP 400 and the rest to 500).
 * - Notifications return HTTP 204 with an empty body.
 * - Supported methods: ping, initialize, tools/list, tools/call, resources/list,
 *   resources/read. Anything else -> -32601 "Method not found: <method>".
 * - tools/call of run_web_automation streams text/event-stream: `data:` frames
 *   only (no `event:` lines, no `:` comments — heartbeats are ordinary progress
 *   notifications), 3 progress notifications then the final JSON-RPC response.
 * - Other tool names echo their arguments back as a CallToolResult.
 * - Asserts the proxy sent X-API-Key and the X-TF-* attribution headers.
 *   DIVERGENCE from real upstream (deliberately stricter, and an invented 401
 *   shape): the real server 204s notifications before auth runs; this mock
 *   rejects notifications missing the headers too, so tests catch header
 *   regressions on every call type.
 *
 * Script knobs: `authReject` (canned auth-layer rejection), plus per-call
 * tool arguments `frameDelayMs`, `crashAfterFrames`, `omitRunMeta`, and
 * `noProgress` on run_web_automation; `seen` records method / sessionId /
 * authorization / protocolVersion / aborted / parsed request body per request.
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export const ErrorCodes = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

type JsonRpcId = string | number;

const SESSION_HEADER = "Mcp-Session-Id";

const REQUIRED_PROXY_HEADERS = [
  "x-api-key",
  "x-tf-request-origin",
  "x-tf-client-name",
  "x-tf-client-version",
] as const;

// ---------------------------------------------------------------------------
// Fixtures (exported so the scripted client can byte-compare against them)
// ---------------------------------------------------------------------------

export const MOCK_RUN_ID = "run_mock_0001";

export const MOCK_INSTRUCTIONS =
  "TinyFish Search and Fetch are free and the most token-efficient way to retrieve current " +
  "web context. (Mock stand-in for the hosted server's long instructions string — the proxy " +
  "must pass it through verbatim, byte for byte, including this parenthetical.)";

/** Shape mirrors the hosted server's initialize result (protocolVersion always 2025-11-25). */
export const MOCK_INITIALIZE_RESULT = {
  protocolVersion: "2025-11-25",
  capabilities: {
    tools: { listChanged: false },
    resources: { listChanged: false },
  },
  serverInfo: { name: "tinyfish", version: "9.9.9-mock" },
  instructions: MOCK_INSTRUCTIONS,
};

export const MOCK_TOOLS_RESULT = {
  tools: [
    {
      name: "echo",
      description: "Mock echo tool: returns its arguments as text.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        additionalProperties: true,
      },
    },
    {
      name: "run_web_automation",
      description:
        "Mock of the hosted automation tool. Streams progress notifications over SSE, " +
        "then a final CallToolResult. Include _meta.progressToken for progress notifications.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string" },
          goal: { type: "string" },
        },
        required: ["goal"],
      },
    },
  ],
};

export const MOCK_RESOURCES_RESULT = {
  resources: [
    {
      uri: "tinyfish://mock/readme",
      name: "mock-readme",
      mimeType: "text/plain",
      description: "A mock resource served by the fake upstream.",
    },
  ],
};

export function buildResourceReadResult(uri: string) {
  return {
    contents: [{ uri, mimeType: "text/plain", text: `mock contents of ${uri}` }],
  };
}

/** Mirrors the hosted server's echo path: a plain CallToolResult. */
export function buildEchoResult(name: string, args: unknown) {
  return {
    content: [
      {
        type: "text",
        text: `Echo from mock upstream tool "${name}": ${JSON.stringify(args ?? {})}`,
      },
    ],
    isError: false,
  };
}

/**
 * The scripted SSE sequence for run_web_automation, mirroring the hosted
 * server's frame shapes:
 * params key order progressToken, progress, total, message, _meta; heartbeat is
 * an ordinary progress notification; final response result key order
 * content, isError, _meta, structuredContent (formatComplete sets _meta before
 * structuredContent).
 */
export function buildAutomationSseMessages(
  progressToken: string | number | undefined,
  requestId: JsonRpcId,
): Record<string, unknown>[] {
  const token = progressToken ?? "unknown";
  const resultJson = { headline: "Mock automation extracted this", items: [1, 2, 3] };
  return [
    {
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: {
        progressToken: token,
        progress: 0,
        total: 100,
        message:
          `Run ${MOCK_RUN_ID} started. IMPORTANT: If this tool errors or times out, do NOT ` +
          `retry. The run is still executing. Call get_run with id "${MOCK_RUN_ID}" to check ` +
          `status instead.`,
        _meta: { runId: MOCK_RUN_ID },
      },
    },
    {
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: {
        progressToken: token,
        progress: 1,
        total: 100,
        message: "Navigating to the target page",
        _meta: {
          runId: MOCK_RUN_ID,
          screenshotUrl: `https://mock.tinyfish.ai/screenshots/${MOCK_RUN_ID}/latest.png`,
        },
      },
    },
    {
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: {
        progressToken: token,
        progress: 2,
        total: 100,
        message: "Heartbeat: run is still ongoing",
      },
    },
    {
      jsonrpc: "2.0",
      id: requestId,
      result: {
        content: [{ type: "text", text: JSON.stringify(resultJson, null, 2) }],
        isError: false,
        _meta: { profile_hint: "Mock profile hint: pass use_profile=true to reuse saved sessions." },
        structuredContent: {
          runId: MOCK_RUN_ID,
          status: "completed",
          runUrl: `https://mock.tinyfish.ai/runs/${MOCK_RUN_ID}`,
          result: resultJson,
        },
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export interface MockUpstream {
  url: string;
  port: number;
  server: Server;
  /**
   * Requests seen, in order (method + session id + inbound Authorization
   * header, which the proxy must never forward), for client-side assertions.
   * `aborted` flips to true when the proxy tears the connection down before
   * the response finished (client-disconnect must propagate as an upstream
   * abort — the mock observes it here).
   */
  seen: Array<{
    method: string | undefined;
    sessionId: string | null;
    authorization: string | null;
    protocolVersion: string | null;
    aborted: boolean;
    /** The parsed JSON request body, so tests can assert the request reached upstream verbatim. */
    body: unknown;
  }>;
  /**
   * Mutable knob: when set, EVERY request is answered with this
   * canned rejection before any routing — simulating an auth layer or
   * intermediary answering with an arbitrary status/content-type/body (e.g. a
   * 401 text page, or a 401 whose body IS a JSON-RPC error). The body string
   * is sent verbatim so tests can byte-compare. Reset to null when done.
   */
  authReject: { status: number; contentType: string; body: string } | null;
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  res.writeHead(status, { "Content-Type": "application/json", ...extraHeaders });
  res.end(JSON.stringify(payload));
}

function jsonRpcError(
  res: ServerResponse,
  code: number,
  message: string,
  id: JsonRpcId,
  extraHeaders: Record<string, string> = {},
): void {
  // Hosted-server convention: client-error codes -> HTTP 400, everything else -> 500.
  const isClientError =
    code === ErrorCodes.ParseError ||
    code === ErrorCodes.InvalidRequest ||
    code === ErrorCodes.InvalidParams ||
    code === ErrorCodes.MethodNotFound;
  sendJson(
    res,
    isClientError ? 400 : 500,
    { jsonrpc: "2.0", error: { code, message }, id },
    extraHeaders,
  );
}

function jsonRpcSuccess(
  res: ServerResponse,
  result: unknown,
  id: JsonRpcId,
  sessionHeaders: Record<string, string>,
): void {
  sendJson(res, 200, { jsonrpc: "2.0", result, id }, sessionHeaders);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Stream the scripted SSE sequence. Test-only knobs read from the tool
 * arguments (the real upstream ignores unknown arguments, so these are safe
 * mock divergences):
 * - `frameDelayMs` (default 15): delay between frames — slow it down so tests
 *   and manual checks can abort mid-stream deterministically.
 * - `crashAfterFrames`: destroy the socket after N frames (mid-stream
 *   upstream-disconnect simulation; the proxy must not relay it as a clean
 *   end).
 * - `omitRunMeta`: strip `params._meta` from progress frames, so a
 *   crash test can exercise the no-runId-seen branch of the mid-stream error
 *   frame.
 * - `noProgress`: degenerate stream — the FIRST frame is the final
 *   JSON-RPC response, no progress notifications precede it (still served as
 *   text/event-stream, like an upstream whose run finishes instantly).
 * A premature client (= proxy) disconnect marks the seen entry aborted and
 * stops the frame loop — no writes into a dead socket.
 */
async function streamAutomation(
  res: ServerResponse,
  scriptedMessages: Record<string, unknown>[],
  entry: MockUpstream["seen"][number],
  args: Record<string, unknown>,
): Promise<void> {
  const frameDelayMs = typeof args.frameDelayMs === "number" ? args.frameDelayMs : 15;
  const crashAfterFrames =
    typeof args.crashAfterFrames === "number" ? args.crashAfterFrames : undefined;
  let messages =
    args.omitRunMeta === true
      ? scriptedMessages.map((message) => {
          const params = message.params as Record<string, unknown> | undefined;
          if (params === undefined || !("_meta" in params)) return message;
          const rest = Object.fromEntries(
            Object.entries(params).filter(([key]) => key !== "_meta"),
          );
          return { ...message, params: rest };
        })
      : scriptedMessages;
  if (args.noProgress === true) {
    // Only the final JSON-RPC response frame — no progress notifications.
    messages = messages.slice(-1);
  }
  let clientGone = false;
  res.on("close", () => {
    // 'close' also fires after a normal end(); only a close before the
    // response finished is a premature teardown (= the proxy aborted).
    if (!res.writableEnded) {
      clientGone = true;
      entry.aborted = true;
    }
  });
  // The hosted server's SSE responses do NOT echo Mcp-Session-Id — they set
  // only the stream headers below.
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  let written = 0;
  for (const message of messages) {
    if (clientGone) return;
    if (crashAfterFrames !== undefined && written >= crashAfterFrames) {
      res.destroy();
      return;
    }
    // The hosted server's frames are bare `data:` lines.
    res.write(`data: ${JSON.stringify(message)}\n\n`);
    written += 1;
    await sleep(frameDelayMs);
  }
  res.end();
}

export function startMockUpstream(): Promise<MockUpstream> {
  const seen: MockUpstream["seen"] = [];

  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      jsonRpcError(res, ErrorCodes.InternalError, `Internal server error: ${String(err)}`, -1);
    });
  });

  const mock: MockUpstream = {
    url: "",
    port: 0,
    server,
    seen,
    authReject: null,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      // Next.js returns 405 for methods the route does not export (incl. DELETE).
      res.writeHead(405, { Allow: "POST" });
      res.end();
      return;
    }

    // Canned auth-layer rejection knob: body verbatim, before routing.
    if (mock.authReject !== null) {
      res.writeHead(mock.authReject.status, { "Content-Type": mock.authReject.contentType });
      res.end(mock.authReject.body);
      return;
    }

    for (const header of REQUIRED_PROXY_HEADERS) {
      if (!req.headers[header]) {
        sendJson(res, 401, {
          jsonrpc: "2.0",
          error: { code: -32000, message: `Mock upstream: missing required header ${header}` },
          id: -1,
        });
        return;
      }
    }

    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      jsonRpcError(res, ErrorCodes.ParseError, "Parse error: Invalid JSON", -1);
      return;
    }

    const method = typeof body.method === "string" ? body.method : undefined;
    const isNotification = method !== undefined && !("id" in body);

    // The hosted server handles notifications before session resolution.
    if (isNotification) {
      seen.push({
        method,
        sessionId: (req.headers["mcp-session-id"] as string) ?? null,
        authorization: req.headers.authorization ?? null,
        protocolVersion: (req.headers["mcp-protocol-version"] as string) ?? null,
        aborted: false,
        body,
      });
      res.writeHead(204);
      res.end();
      return;
    }

    if (body.jsonrpc !== "2.0" || method === undefined || body.id === undefined) {
      jsonRpcError(
        res,
        ErrorCodes.InvalidRequest,
        "Invalid JSON-RPC 2.0 request format",
        (body.id as JsonRpcId) ?? -1,
      );
      return;
    }
    const id = body.id as JsonRpcId;
    const params = (body.params ?? {}) as Record<string, unknown>;

    // Hosted server's session model: header wins; initialize mints a
    // UUID; ids are never validated beyond non-emptiness.
    const headerSession = (req.headers["mcp-session-id"] as string | undefined) || null;
    const sessionId = headerSession ?? (method === "initialize" ? randomUUID() : null);
    if (sessionId === null && method !== "ping") {
      jsonRpcError(res, ErrorCodes.InvalidRequest, "Missing required Mcp-Session-Id header", id);
      return;
    }
    const sessionHeaders: Record<string, string> = sessionId
      ? { [SESSION_HEADER]: sessionId }
      : {};
    const entry: MockUpstream["seen"][number] = {
      method,
      sessionId,
      authorization: req.headers.authorization ?? null,
      protocolVersion: (req.headers["mcp-protocol-version"] as string) ?? null,
      aborted: false,
      body,
    };
    seen.push(entry);

    switch (method) {
      case "ping":
        jsonRpcSuccess(res, {}, id, sessionHeaders);
        return;
      case "initialize":
        jsonRpcSuccess(res, MOCK_INITIALIZE_RESULT, id, sessionHeaders);
        return;
      case "tools/list":
        jsonRpcSuccess(res, MOCK_TOOLS_RESULT, id, sessionHeaders);
        return;
      case "tools/call": {
        const name = typeof params.name === "string" ? params.name : "";
        if (name === "run_web_automation") {
          const meta = (params._meta ?? {}) as Record<string, unknown>;
          const token = meta.progressToken as string | number | undefined;
          const args = (params.arguments ?? {}) as Record<string, unknown>;
          await streamAutomation(res, buildAutomationSseMessages(token, id), entry, args);
          return;
        }
        jsonRpcSuccess(res, buildEchoResult(name, params.arguments), id, sessionHeaders);
        return;
      }
      case "resources/list":
        jsonRpcSuccess(res, MOCK_RESOURCES_RESULT, id, sessionHeaders);
        return;
      case "resources/read":
        jsonRpcSuccess(
          res,
          buildResourceReadResult(typeof params.uri === "string" ? params.uri : "mock://unknown"),
          id,
          sessionHeaders,
        );
        return;
      default:
        jsonRpcError(res, ErrorCodes.MethodNotFound, `Method not found: ${method}`, id);
        return;
    }
  }

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      mock.port = port;
      mock.url = `http://127.0.0.1:${port}/mcp`;
      resolve(mock);
    });
  });
}
