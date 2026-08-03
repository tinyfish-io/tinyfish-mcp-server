/**
 * Per-request MCP wiring over the transport-agnostic proxy core.
 *
 * Session bridging (raw-pipe, spike decision B): the local client re-sends
 * whatever Mcp-Session-Id upstream issued, so the client-sent header IS the
 * core localKey. For `initialize` — where no upstream id exists yet — a
 * locally generated key seeds the session entry, and the core aliases that
 * entry under the upstream-issued id once the response arrives. `Mcp-Session-Id`
 * is echoed on JSON responses exactly when upstream echoed it (the core hands
 * back the echoed value; null on SSE — upstream's SSE path sets no session
 * header, and neither do we).
 *
 * Local-hop auth is server-holds-key: inbound Authorization headers are
 * ignored — the only client headers that influence the upstream call are
 * Mcp-Session-Id and MCP-Protocol-Version; the core builds every outbound
 * header itself.
 *
 * Streaming (Phase 5): when upstream answers SSE, frames are relayed through
 * the core's onEvent into an SSE response using the ORIGINAL `data:` payload
 * string (byte-verbatim relay — no re-serialization). Each write is awaited
 * (backpressure), a local client disconnect aborts the upstream fetch via a
 * per-request AbortSignal (no orphaned upstream streams), and mid-stream
 * failures are classified: local write failures are never labeled upstream.
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  JsonRpcErrorCodes,
  LocalWriteError,
  ProxyCoreError,
  toJsonRpcError,
  toStreamErrorFrame,
} from "../core/errors.js";
import { requestIdOf, type OnEvent, type ProxyCore, type ProxyResponse } from "../core/proxy-core.js";
import { log } from "../log.js";
import type { RequestHandler } from "./index.js";

export function createMcpAdapter(core: ProxyCore): RequestHandler {
  return async (req, res) => {
    const sessionId = headerValue(req, "mcp-session-id");
    const protocolVersion = headerValue(req, "mcp-protocol-version");

    const raw = await readBody(req);
    let message: unknown;
    try {
      message = JSON.parse(raw.toString("utf8"));
    } catch {
      // Local ParseError mirroring upstream's shape (shared/json-rpc.ts:
      // client-error codes → HTTP 400; id -1 when no request id is known).
      // The one case the proxy answers without forwarding — it cannot route
      // what it cannot parse.
      sendJson(res, 400, {
        jsonrpc: "2.0",
        error: { code: JsonRpcErrorCodes.ParseError, message: "Parse error: Invalid JSON" },
        id: -1,
      });
      return;
    }

    try {
      await route(core, res, message, sessionId, protocolVersion);
    } catch (err) {
      // Phase 6: every failure upstream never answered as JSON-RPC is shaped
      // through the one function in core/errors.ts. Streamed requests handle
      // their own mid-stream failures and only rethrow pre-stream ones, so
      // headers are normally unsent here; the guard covers a write that died
      // halfway through sending a response.
      logFailure(err);
      if (res.headersSent) {
        res.end();
        return;
      }
      const shaped = toJsonRpcError(err, requestIdOf(message));
      sendJson(res, shaped.httpStatus, shaped.body);
    }
  };
}

async function route(
  core: ProxyCore,
  res: ServerResponse,
  message: unknown,
  sessionId: string | undefined,
  protocolVersion: string | undefined
): Promise<void> {
  // Notification (has method, no id): forward, answer 204 empty like upstream.
  if (isNotification(message)) {
    // localKey "" ⇒ the core sends no Mcp-Session-Id upstream (transparent
    // for session-less notifications); a real client id replays verbatim.
    await core.notify(sessionId ?? "", message, protocolVersion);
    res.writeHead(204);
    res.end();
    return;
  }

  const method = methodOf(message);

  if (method === "initialize") {
    // No upstream session exists yet: a generated localKey seeds the entry
    // unless the client is re-initializing with a session id it already
    // holds. The client-sent id (if any) is passed separately so the core
    // replays it upstream (upstream adopts client-sent header ids) without
    // ever sending an adapter-invented key.
    const localKey = sessionId ?? randomUUID();
    const response = await core.initialize(localKey, message, protocolVersion, sessionId);
    sendProxyResponse(res, response);
    return;
  }

  if (method === "tools/call") {
    await relayPossiblyStreaming(core, sessionId ?? "", message, protocolVersion, res);
    return;
  }

  // Everything else — ping, tools/list, resources/*, unknown methods, and
  // shapeless bodies — forwards generically; upstream's status and body
  // (including MethodNotFound / InvalidRequest errors) pass through verbatim.
  // JSON-RPC BATCH ARRAYS land here too (methodOf/isNotification treat an
  // array as shapeless): MCP forbids batching and upstream does not support
  // it, so a batch is not special-cased anywhere — it forwards as-is and
  // upstream answers its own InvalidRequest. Same story on the response side:
  // upstream.ts's isJsonRpcMessage gate excludes arrays by design.
  const response = await core.forward(sessionId ?? "", message, protocolVersion);
  sendProxyResponse(res, response);
}

/**
 * Log a shaped failure to stderr. Classified core errors log their (key-free)
 * message; anything else is a local proxy bug and logs its full stack — the
 * client only ever sees the generic InternalError message.
 */
function logFailure(err: unknown): void {
  if (err instanceof ProxyCoreError) {
    log.warn(err.message);
    return;
  }
  log.error(
    `proxy bug (client got a generic InternalError): ${
      err instanceof Error ? (err.stack ?? err.message) : String(err)
    }`
  );
}

/**
 * tools/call may answer JSON or SSE; the adapter cannot know which until the
 * core either emits an event (⇒ SSE) or resolves. The SSE response is opened
 * lazily on the first relayed frame; the resolved final frame is appended and
 * the stream closed. Each write is awaited (OnEvent may return a promise), so
 * socket backpressure propagates into the core's frame loop.
 *
 * Client-disconnect abort: if the local socket closes before the response is
 * finished ('close' with writableEnded false — 'close' alone also fires on
 * normal completion), the per-request AbortSignal fires and the core aborts
 * the upstream fetch. That surfaces as an UpstreamAbortedError rejection,
 * absorbed here as an ordinary disconnect (nobody is left to answer).
 *
 * Note: an SSE stream that carried ONLY the final frame still relays as a
 * plain JSON response (streaming never turned true). Real upstream always
 * emits progress first; if it ever mattered, the final frame's rawBody is the
 * verbatim payload either way.
 */
async function relayPossiblyStreaming(
  core: ProxyCore,
  localKey: string,
  message: unknown,
  protocolVersion: string | undefined,
  res: ServerResponse
): Promise<void> {
  let streaming = false;
  // Last _meta.runId seen in a relayed progress frame — upstream names the
  // run there so a mid-stream failure can hand the client a recovery handle
  // (rules table: include run_id in the error frame's data when seen).
  let lastRunId: string | undefined;
  const clientAbort = new AbortController();
  const onClose = (): void => {
    if (!res.writableEnded) clientAbort.abort();
  };
  res.on("close", onClose);

  const onEvent: OnEvent = async (event, rawData) => {
    if (!streaming) {
      streaming = true;
      // Mirror upstream's SSE headers. Deliberately no Mcp-Session-Id:
      // upstream's SSE path never sets one (Phase 5 invariant).
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      });
    }
    lastRunId = runIdOf(event) ?? lastRunId;
    await writeSseFrame(res, event, rawData);
  };

  try {
    const response = await core.forwardStream(
      localKey,
      message,
      onEvent,
      protocolVersion,
      clientAbort.signal
    );
    if (streaming) {
      try {
        await writeSseFrame(res, response.body, response.rawBody);
      } catch (err) {
        // A final-frame write failure is a LOCAL socket condition, exactly
        // like a progress-frame write failure inside onEvent — classify it the
        // same way so it can never be mislabeled as an upstream stream failure
        // (Phase 5 review gap 2).
        throw new LocalWriteError(
          `Relaying the final SSE frame to the local client failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
          { cause: err }
        );
      }
      res.end();
      return;
    }
    // Plain JSON answer: written with upstream's status, body verbatim.
    sendProxyResponse(res, response);
  } catch (err) {
    if (clientAbort.signal.aborted) {
      // The local client went away; the upstream fetch was aborted through the
      // per-request signal. Not an upstream failure — log it as what it is.
      log.warn("local client disconnected mid-tools/call; upstream request aborted");
      res.destroy();
      return;
    }
    if (err instanceof LocalWriteError) {
      // Writing to the local client socket failed (client dying but 'close'
      // not yet observed). Teardown already happened in the core (the throw
      // exits the frame loop, canceling the upstream stream). Never labeled
      // "Upstream unreachable" (Phase 4 review gap 2).
      log.warn(err.message);
      res.destroy();
      return;
    }
    if (streaming) {
      // The stream broke after the local SSE response already started. Emit
      // the final SSE-framed JSON-RPC error per the Phase 6 rules table
      // (-32000, "the run may still be executing", runId in data when seen)
      // — never an unframed body into a started SSE stream. The log prefix
      // names the actual culprit: a classified core error is an upstream-leg
      // failure; anything else is a LOCAL proxy bug and must not be logged
      // with an upstream-blaming label (same mislabel class as gap 2).
      if (err instanceof ProxyCoreError) {
        log.error(`upstream stream failed mid-relay: ${err.message}`);
      } else {
        log.error(
          `proxy bug mid-stream (client got a framed InternalError): ${
            err instanceof Error ? (err.stack ?? err.message) : String(err)
          }`
        );
      }
      const errorFrame = toStreamErrorFrame(err, requestIdOf(message), lastRunId);
      await writeSseFrame(res, errorFrame).catch(() => undefined);
      res.end();
      return;
    }
    // Pre-stream failures (headers not sent) rethrow to the shaping catch in
    // the handler (toJsonRpcError → -32000/-32001/-32603 with an HTTP status).
    throw err;
  } finally {
    res.removeListener("close", onClose);
  }
}

/** Extract `params._meta.runId` from a relayed progress notification, if present. */
function runIdOf(event: unknown): string | undefined {
  if (typeof event !== "object" || event === null) return undefined;
  const params = (event as { params?: unknown }).params;
  if (typeof params !== "object" || params === null) return undefined;
  const meta = (params as { _meta?: unknown })._meta;
  if (typeof meta !== "object" || meta === null) return undefined;
  const runId = (meta as { runId?: unknown }).runId;
  return typeof runId === "string" && runId.length > 0 ? runId : undefined;
}

/** Write upstream's status + JSON-RPC body verbatim; echo the session header. */
function sendProxyResponse(res: ServerResponse, response: ProxyResponse): void {
  // Copy upstream's Content-Type through (spike guidance); fall back for
  // locally synthesized responses (e.g. an SSE final frame answered as JSON).
  const headers: Record<string, string> = {
    "Content-Type": response.contentType ?? "application/json",
  };
  if (response.sessionId !== null) {
    headers["Mcp-Session-Id"] = response.sessionId;
  }
  sendJson(res, response.status, response.body, headers);
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = { "Content-Type": "application/json" }
): void {
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

/**
 * One SSE frame; resolves when the chunk is flushed. Relays the ORIGINAL
 * upstream payload string when available (byte-verbatim — spike guidance);
 * falls back to JSON.stringify for locally synthesized frames. A payload
 * containing newlines (multi-line `data:` field) is re-split into one
 * `data:` line per payload line, which reconstructs to identical bytes on the
 * receiving parser.
 */
function writeSseFrame(res: ServerResponse, message: unknown, rawData?: string): Promise<void> {
  const payload = rawData ?? JSON.stringify(message);
  const frame = payload
    .split("\n")
    .map((line) => `data: ${line}`)
    .join("\n");
  return new Promise((resolve, reject) => {
    res.write(`${frame}\n\n`, (err) => (err ? reject(err) : resolve()));
  });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Node folds duplicate headers into one comma-joined string; empty ⇒ absent. */
function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** JSON-RPC notification: an object with a method and no id key (mock/upstream rule). */
function isNotification(message: unknown): boolean {
  return (
    typeof message === "object" &&
    message !== null &&
    !Array.isArray(message) &&
    typeof (message as { method?: unknown }).method === "string" &&
    !("id" in message)
  );
}

function methodOf(message: unknown): string | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const method = (message as { method?: unknown }).method;
  return typeof method === "string" ? method : undefined;
}
