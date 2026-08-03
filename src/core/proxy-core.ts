/**
 * Transport-agnostic proxy core — the one module every transport wraps.
 *
 * Composes the upstream client (single fetch call site) with the session
 * store (abort tracking + session/protocol-version bridging). Routes on
 * JSON-RPC shape and response content type only; never inspects tool names or
 * schemas. All signatures use web-standard types and plain callbacks — no
 * node:http anywhere.
 *
 * SSE frames are parsed by the incremental parser in core/sse.ts and carry
 * both the parsed JSON and the raw data payload string, so a relaying
 * transport can pipe upstream's bytes through verbatim.
 */
import { log } from "../log.js";
import { shutdownHooks } from "../shutdown.js";
import { LocalWriteError, ProxyCoreError, UpstreamProtocolError } from "./errors.js";
import { SessionStore } from "./session.js";
import { parseSseStream } from "./sse.js";
import { toTransportError, UpstreamClient, type FetchLike } from "./upstream.js";

/**
 * Plain callback invoked per intermediate SSE frame (progress notifications).
 * May return a promise; forwardStream awaits each emission before reading the
 * next frame, so a relaying transport can propagate write backpressure.
 * `rawData` is the frame's original `data:` payload string
 * (multi-line values joined with "\n") — relay it verbatim when possible; the
 * parsed `message` is a fallback for transports that must re-serialize. A
 * rejection from onEvent surfaces as LocalWriteError (client-side condition),
 * never as an upstream transport error.
 *
 * DELIBERATE DROP: SSE `event:` and
 * `id:` fields are parsed by core/sse.ts but NOT carried through this
 * callback — only the `data:` payload is relayed. The verified upstream sends
 * bare `data:` frames exclusively, so threading them through would be dead
 * plumbing today; if upstream ever starts emitting these fields, extend
 * OnEvent (SseEvent already surfaces them) and the adapter's writeSseFrame.
 */
export type OnEvent = (message: unknown, rawData?: string) => void | Promise<void>;

/**
 * A completed upstream exchange. `body` is the raw JSON-RPC response object,
 * verbatim — success or error, never unwrapped. `status` is upstream's HTTP
 * status (it must survive to the client). `sessionId` is the
 * Mcp-Session-Id upstream echoed on JSON responses (null on SSE — upstream's
 * SSE path sets no session header).
 */
export interface ProxyResponse {
  status: number;
  body: unknown;
  sessionId: string | null;
  /**
   * Upstream's Content-Type header for JSON responses (adapter copies it
   * through rather than hardcoding its own). Null when synthesized locally
   * (e.g. the final frame of an SSE stream).
   */
  contentType: string | null;
  /**
   * SSE path only: the final frame's original `data:` payload string, so a
   * relaying transport can emit upstream's bytes verbatim. Absent on plain
   * JSON responses.
   */
  rawBody?: string;
}

export interface ProxyCore {
  /**
   * POST the client's initialize request upstream verbatim; capture
   * Mcp-Session-Id from the response headers into the session map; return
   * upstream's raw JSON-RPC response (upstream always answers
   * protocolVersion 2025-11-25).
   */
  initialize(
    localKey: string,
    initializeRequest: unknown,
    clientProtocolVersion?: string,
    /**
     * Mcp-Session-Id the CLIENT sent on this initialize, if any. The hosted
     * server adopts a client-sent header id instead of minting one, so a
     * re-initialize after a proxy restart must replay it. Never an
     * adapter-invented key.
     */
    clientSessionId?: string
  ): Promise<ProxyResponse>;
  /**
   * Forward a JSON-RPC notification; upstream answers 204; resolves void.
   * `clientProtocolVersion` is the MCP-Protocol-Version the client sent on
   * THIS call (headers are per-request on the wire); falls back to the value
   * captured at initialize when omitted.
   */
  notify(localKey: string, notification: unknown, clientProtocolVersion?: string): Promise<void>;
  /** Non-streaming forward with the stored session id; response verbatim. */
  forward(
    localKey: string,
    request: unknown,
    clientProtocolVersion?: string
  ): Promise<ProxyResponse>;
  /**
   * Forward a request that may stream. If upstream answers text/event-stream,
   * onEvent is called per SSE frame that is a notification and the promise
   * resolves with the frame that is the final JSON-RPC response (matching the
   * request id). If upstream answers plain JSON, resolves with it directly.
   *
   * `signal` (optional) additionally aborts THIS request's upstream fetch —
   * the transport fires it on local client disconnect so no upstream stream
   * is orphaned. Distinct from close(), which tears down the whole session.
   */
  forwardStream(
    localKey: string,
    request: unknown,
    onEvent: OnEvent,
    clientProtocolVersion?: string,
    signal?: AbortSignal
  ): Promise<ProxyResponse>;
  /** Abort in-flight upstream fetches for the session, drop the mapping. Local-only. */
  close(localKey: string): void;
  /** Close every session (shutdown). */
  closeAll(): void;
}

export interface ProxyCoreOptions {
  upstreamUrl: string;
  /** Never logged. */
  apiKey: string;
  /** X-TF-Client-Version override; defaults to the package version. */
  clientVersion?: string;
  /** Injectable fetch so unit tests need no network. */
  fetchFn?: FetchLike;
  /**
   * Where to register session cleanup for process shutdown. Defaults to the
   * process-wide shutdownHooks array; pass null to skip registration (tests).
   */
  hooks?: Array<() => void | Promise<void>> | null;
}

export function createProxyCore(options: ProxyCoreOptions): ProxyCore {
  const upstream = new UpstreamClient({
    url: options.upstreamUrl,
    apiKey: options.apiKey,
    clientVersion: options.clientVersion,
    fetchFn: options.fetchFn,
  });
  const sessions = new SessionStore();

  /**
   * Run an upstream exchange with an abort controller tracked on the session.
   * An optional external signal (per-request, e.g. local client disconnect)
   * also fires the tracked controller, so session close and client disconnect
   * abort through the same path.
   */
  async function withInflight<T>(
    localKey: string,
    fn: (signal: AbortSignal) => Promise<T>,
    externalSignal?: AbortSignal
  ): Promise<T> {
    const controller = sessions.beginRequest(localKey);
    const onExternalAbort = (): void => controller.abort();
    if (externalSignal !== undefined) {
      if (externalSignal.aborted) controller.abort();
      else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }
    try {
      return await fn(controller.signal);
    } finally {
      externalSignal?.removeEventListener("abort", onExternalAbort);
      sessions.endRequest(localKey, controller);
    }
  }

  const core: ProxyCore = {
    async initialize(localKey, initializeRequest, clientProtocolVersion, clientSessionId) {
      const entry = sessions.getOrCreate(localKey);
      if (clientProtocolVersion !== undefined) {
        entry.protocolVersion = clientProtocolVersion;
      }
      const response = await withInflight(localKey, (signal) =>
        upstream.post(initializeRequest, {
          // No localKey fallback here: upstream adopts any header id verbatim,
          // so sending an adapter-invented key on initialize would prevent
          // upstream from minting the session id. A CLIENT-sent id, however,
          // must replay (upstream honors it — proxy-restart transparency).
          sessionId: entry.upstreamSessionId ?? clientSessionId,
          protocolVersion: entry.protocolVersion,
          signal,
        })
      );
      if (response.kind !== "json") {
        throw new UpstreamProtocolError(
          `Unexpected ${response.kind} response to initialize (HTTP ${response.status})`,
          response.status
        );
      }
      // Re-fetch: the session may have been closed while the fetch was in flight.
      const live = sessions.get(localKey);
      if (live !== undefined && response.sessionId !== null) {
        live.upstreamSessionId = response.sessionId;
        // Alias the entry under the upstream-issued id: the client re-sends
        // upstream's id, so later calls arrive keyed by it.
        sessions.alias(response.sessionId, live);
      }
      return {
        status: response.status,
        body: response.body,
        sessionId: response.sessionId,
        contentType: response.contentType,
      };
    },

    async notify(localKey, notification, clientProtocolVersion) {
      const entry = sessions.getOrCreate(localKey);
      const response = await withInflight(localKey, (signal) =>
        upstream.post(notification, {
          // No captured id means the client is re-sending upstream's own id as
          // the local key — replay the key itself.
          sessionId: entry.upstreamSessionId ?? localKey,
          protocolVersion: clientProtocolVersion ?? entry.protocolVersion,
          signal,
        })
      );
      // Upstream's contract for notifications is HTTP 204, empty body.
      // Deliberate: any other successful-fetch answer —
      // including a JSON-RPC error body — is deliberately swallowed after a
      // stderr warning, because a JSON-RPC notification has no response
      // channel to relay it on (the local client still gets its 204).
      // Transport/auth failures that THROW (unreachable, 401 with a
      // non-JSON-RPC body) still propagate and are shaped by the adapter.
      // Unreachable against today's real upstream, which 204s notifications
      // before auth runs — revisit if the API-key branch changes that.
      if (response.kind !== "empty") {
        const errorCode =
          response.kind === "json" ? jsonRpcErrorCodeOf(response.body) : undefined;
        const codeSuffix = errorCode !== undefined ? `, JSON-RPC error ${errorCode}` : "";
        log.warn(
          `notification got unexpected ${response.kind} response ` +
            `(HTTP ${response.status}${codeSuffix}) — dropped; ` +
            `notifications have no response channel`
        );
      }
    },

    async forward(localKey, request, clientProtocolVersion) {
      const entry = sessions.getOrCreate(localKey);
      const response = await withInflight(localKey, (signal) =>
        upstream.post(request, {
          sessionId: entry.upstreamSessionId ?? localKey,
          protocolVersion: clientProtocolVersion ?? entry.protocolVersion,
          signal,
        })
      );
      if (response.kind !== "json") {
        throw new UpstreamProtocolError(
          `Unexpected ${response.kind} response to non-streaming request (HTTP ${response.status})`,
          response.status
        );
      }
      return {
        status: response.status,
        body: response.body,
        sessionId: response.sessionId,
        contentType: response.contentType,
      };
    },

    async forwardStream(localKey, request, onEvent, clientProtocolVersion, abortSignal) {
      const entry = sessions.getOrCreate(localKey);
      return withInflight(
        localKey,
        async (signal) => {
          const response = await upstream.post(request, {
            sessionId: entry.upstreamSessionId ?? localKey,
            protocolVersion: clientProtocolVersion ?? entry.protocolVersion,
            signal,
          });
          if (response.kind === "json") {
            return {
              status: response.status,
              body: response.body,
              sessionId: response.sessionId,
              contentType: response.contentType,
            };
          }
          if (response.kind === "sse") {
            const finalFrame = await readSseUntilFinal(
              response.stream,
              requestIdOf(request),
              onEvent
            );
            // Upstream SSE responses never carry Mcp-Session-Id; the final frame
            // is synthesized from the stream, so no upstream Content-Type applies.
            return {
              status: response.status,
              body: finalFrame.message,
              sessionId: null,
              contentType: null,
              rawBody: finalFrame.rawData,
            };
          }
          throw new UpstreamProtocolError(
            `Unexpected empty response to a request (HTTP ${response.status})`,
            response.status
          );
        },
        abortSignal
      );
    },

    close(localKey) {
      sessions.close(localKey);
    },

    closeAll() {
      sessions.closeAll();
    },
  };

  const hooks = options.hooks === undefined ? shutdownHooks : options.hooks;
  if (hooks !== null) {
    hooks.push(() => core.closeAll());
  }

  return core;
}

// ---------------------------------------------------------------------------
// SSE stream consumption (parser lives in core/sse.ts)
// ---------------------------------------------------------------------------

/** The JSON-RPC error code of a response body, if it is an error response. */
function jsonRpcErrorCodeOf(body: unknown): number | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" ? code : undefined;
}

/**
 * The JSON-RPC id of a request message, undefined when absent. Single copy —
 * the HTTP adapter imports this too; the shaping functions in core/errors.ts
 * normalize undefined to null themselves.
 */
export function requestIdOf(request: unknown): unknown {
  if (typeof request === "object" && request !== null && "id" in request) {
    return (request as { id: unknown }).id;
  }
  return undefined;
}

/** A JSON-RPC response frame: has result/error, no method; id must match. */
function isFinalResponse(message: unknown, requestId: unknown): boolean {
  if (typeof message !== "object" || message === null) return false;
  const frame = message as Record<string, unknown>;
  if ("method" in frame) return false;
  if (!("result" in frame) && !("error" in frame)) return false;
  return requestId === undefined || frame.id === requestId;
}

/**
 * Consume the SSE stream via parseSseStream, emitting notification frames via
 * onEvent (each emission awaited — backpressure) and returning the final
 * JSON-RPC response frame with its raw payload string. Reading stops at the
 * final frame: breaking out of the for-await runs the generator's return
 * path, which cancels the upstream stream — no waiting on upstream to close,
 * and any spec-violating post-final frames never reach onEvent.
 *
 * Error classification: onEvent rejections (local client write failures) are
 * wrapped as LocalWriteError; stream/read failures map to transport errors
 * (abort → UpstreamAbortedError, network → UpstreamUnreachableError); parser
 * failures are UpstreamProtocolError. Only genuinely unclassified errors go
 * through toTransportError.
 */
async function readSseUntilFinal(
  stream: ReadableStream<Uint8Array>,
  requestId: unknown,
  onEvent: OnEvent
): Promise<{ message: unknown; rawData: string }> {
  let finalFrame: { message: unknown; rawData: string } | undefined;

  try {
    for await (const event of parseSseStream(stream)) {
      if (isFinalResponse(event.message, requestId)) {
        finalFrame = { message: event.message, rawData: event.rawData };
        break;
      }
      // Tolerate and relay any notification method verbatim (future-proofing);
      // a rejected write is a LOCAL failure, never an upstream one.
      try {
        await onEvent(event.message, event.rawData);
      } catch (err) {
        throw new LocalWriteError(
          `Relaying SSE frame to the local client failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
          { cause: err }
        );
      }
    }
  } catch (err) {
    // Already-classified errors (LocalWriteError, UpstreamProtocolError from
    // the parser, typed transport errors) pass through untouched.
    if (err instanceof ProxyCoreError) throw err;
    throw toTransportError(err);
  }

  if (finalFrame === undefined) {
    throw new UpstreamProtocolError("Upstream SSE stream ended without a final response frame");
  }
  return finalFrame;
}
