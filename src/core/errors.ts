/**
 * Typed transport-level errors thrown by the proxy core, plus the one
 * client-facing shaping function (Phase 6): `toJsonRpcError` for pre-stream
 * failures and `toStreamErrorFrame` for failures after an SSE relay started.
 * Every adapter catch path routes through these two functions — no ad-hoc
 * error bodies anywhere else, with exactly two deliberate exceptions (pinned,
 * Phase 7): the adapter's ParseError reply (http/adapter.ts — built where the
 * unparseable body is caught, since there is nothing to route), and the
 * last-resort -32603 backstop in http/index.ts's invokeSafely. Messages must
 * never contain the API key (they describe network/protocol conditions only).
 *
 * HTTP status decision for locally shaped errors (pinned here, Phase 6):
 * upstream's own convention (shared/json-rpc.ts) maps client-error JSON-RPC
 * codes to HTTP 400 and everything else to 500. The proxy mirrors the 400 for
 * client errors (-32700 ParseError) and picks **502 Bad Gateway** for the
 * upstream-leg failures it shapes itself (-32000 unreachable/stream-failed,
 * -32001 auth rejection): the proxy is healthy, the upstream hop failed —
 * distinguishing these from a genuine local proxy bug, which stays **500**
 * with -32603 InternalError. Upstream-originated JSON-RPC errors are never
 * shaped at all: they forward verbatim under upstream's own HTTP status.
 */

/** JSON-RPC error codes used by locally shaped errors. */
export const JsonRpcErrorCodes = {
  /** Upstream unreachable / upstream stream failed (server-side, HTTP 502). */
  UpstreamUnavailable: -32000,
  /** Upstream rejected auth — check TINYFISH_API_KEY (HTTP 502). */
  UpstreamAuth: -32001,
  /** Local proxy bug (HTTP 500). */
  InternalError: -32603,
  /** Malformed client JSON (HTTP 400, id -1 — mirrors upstream). */
  ParseError: -32700,
} as const;

/** Base class for all proxy-core errors (transport level, not JSON-RPC). */
export class ProxyCoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The upstream server could not be reached (DNS, TLS, refused, reset). */
export class UpstreamUnreachableError extends ProxyCoreError {
  /** Upstream "host[:port]" when known — used in the client-facing message. */
  host?: string;
}

/**
 * Upstream answered 401/403 with a body that is NOT a JSON-RPC message (a
 * JSON-RPC error body, whatever its HTTP status, forwards verbatim instead —
 * rules-table row 1). Carries the upstream status and body text so the shaped
 * client error can include them as diagnostics. The body text is truncated to
 * ~2KB at construction; the Error message itself never includes it.
 */
export class UpstreamAuthError extends ProxyCoreError {
  readonly status: number;
  /** Upstream response body text, truncated to AUTH_BODY_LIMIT chars. */
  readonly bodyText: string;

  constructor(status: number, bodyText: string, options?: ErrorOptions) {
    super(`Upstream rejected the request as unauthorized (HTTP ${status})`, options);
    this.status = status;
    this.bodyText = bodyText.slice(0, AUTH_BODY_LIMIT);
  }
}

/**
 * ~2KB cap on the upstream auth-failure body relayed in error data.
 *
 * Measured in UTF-16 code units (String.prototype.slice), not bytes: for
 * multi-byte scripts the UTF-8 wire size can reach ~3× (≤ ~6KB) — bounded
 * either way, which is all the "~2KB" contract promises. A slice boundary can
 * split a surrogate pair; harmless, since Node's well-formed JSON.stringify
 * escapes the lone surrogate and the response stays valid JSON.
 */
export const AUTH_BODY_LIMIT = 2048;

/**
 * Delivering a relayed SSE frame to the LOCAL client failed (the transport's
 * onEvent callback rejected — e.g. the client socket died mid-write). This is
 * a client-side condition, never an upstream one: it must not be logged or
 * classified as "Upstream unreachable" (Phase 4 review gap 2 / Phase 5).
 */
export class LocalWriteError extends ProxyCoreError {}

/** An in-flight upstream request was aborted locally (session close / shutdown). */
export class UpstreamAbortedError extends ProxyCoreError {}

/**
 * Upstream answered with something the core cannot interpret (non-JSON body,
 * SSE stream that ends without a final response frame, unexpected empty body).
 */
export class UpstreamProtocolError extends ProxyCoreError {
  /** Upstream HTTP status when one was received before the failure. */
  readonly status?: number;

  constructor(message: string, status?: number, options?: ErrorOptions) {
    super(message, options);
    this.status = status;
  }
}

/** True for the AbortError DOMException fetch throws when its signal fires. */
export function isAbortError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as { name: unknown }).name === "AbortError"
  );
}

// ---------------------------------------------------------------------------
// Client-facing shaping (Phase 6) — the only place error bodies are built
// ---------------------------------------------------------------------------

export interface JsonRpcErrorBody {
  jsonrpc: "2.0";
  error: { code: number; message: string; data?: unknown };
  id: unknown;
}

/** A shaped failure: the HTTP status to answer with plus the JSON-RPC body. */
export interface ShapedJsonRpcError {
  httpStatus: number;
  body: JsonRpcErrorBody;
}

/**
 * Map a failure the upstream never answered (or answered unusably) to the
 * client-facing JSON-RPC error + local HTTP status, per the Phase 6 rules
 * table. Only failures upstream never saw as JSON-RPC get shaped here —
 * upstream JSON-RPC errors forward verbatim and never reach this function.
 * Never includes the API key: transport-error messages describe network and
 * protocol conditions only, and unexpected local errors get a generic message
 * (their stack goes to stderr at the catch site, not to the client).
 */
export function toJsonRpcError(failure: unknown, requestId: unknown): ShapedJsonRpcError {
  const id = requestId ?? null;

  if (failure instanceof UpstreamAuthError) {
    return {
      httpStatus: 502,
      body: {
        jsonrpc: "2.0",
        error: {
          code: JsonRpcErrorCodes.UpstreamAuth,
          message:
            `Upstream rejected the request (HTTP ${failure.status}) — ` +
            `check that TINYFISH_API_KEY is set to a valid TinyFish API key`,
          data: { upstreamStatus: failure.status, upstreamBody: failure.bodyText },
        },
        id,
      },
    };
  }

  if (failure instanceof UpstreamUnreachableError) {
    const host = failure.host ?? "the upstream server";
    return {
      httpStatus: 502,
      body: {
        jsonrpc: "2.0",
        error: {
          code: JsonRpcErrorCodes.UpstreamUnavailable,
          message:
            `cannot reach ${host} — check your network; ` +
            `the hosted MCP server may also be temporarily unavailable`,
        },
        id,
      },
    };
  }

  if (failure instanceof ProxyCoreError) {
    // Remaining core classifications (protocol violation, local abort): the
    // upstream leg failed but the proxy is healthy — same 502 / -32000 shape,
    // with the classified message (never contains the key or body internals).
    return {
      httpStatus: 502,
      body: {
        jsonrpc: "2.0",
        error: { code: JsonRpcErrorCodes.UpstreamUnavailable, message: failure.message },
        id,
      },
    };
  }

  // Local proxy bug: generic message only; the stack goes to stderr.
  return {
    httpStatus: 500,
    body: {
      jsonrpc: "2.0",
      error: { code: JsonRpcErrorCodes.InternalError, message: "Internal error" },
      id,
    },
  };
}

/**
 * Build the final SSE-framed JSON-RPC error for a failure AFTER the local SSE
 * relay started (rules-table row "mid-stream upstream disconnect"). A
 * tools/call may have side effects, so the message warns that the run may
 * still be executing and is never retried silently; when a run id was already
 * seen in a progress frame's `_meta.runId` it is included in `data.runId`
 * (camelCase, matching upstream's `_meta.runId` convention) and named in the
 * message, else `data` is omitted entirely.
 *
 * The -32000 message differentiates the failure kind: a locally aborted
 * upstream request (session close / shutdown mid-stream) reads differently
 * from an upstream that died or broke protocol — but both keep the "run may
 * still be executing" guidance, because in either case a live run could be
 * left behind upstream.
 */
export function toStreamErrorFrame(
  failure: unknown,
  requestId: unknown,
  runId?: string
): JsonRpcErrorBody {
  const id = requestId ?? null;
  if (failure instanceof ProxyCoreError) {
    // Upstream died / broke protocol / was aborted mid-stream. Not -32603:
    // this is an upstream-leg failure, mirrored to the pre-stream -32000.
    const runHint =
      runId !== undefined
        ? ` Check the run status with get_run id "${runId}" instead of retrying.`
        : ` Check the run status before retrying.`;
    const condition =
      failure instanceof UpstreamAbortedError
        ? "The proxy aborted the upstream request mid-stream (local session closed or shutting down); "
        : "Upstream stream ended unexpectedly before the final response; ";
    return {
      jsonrpc: "2.0",
      error: {
        code: JsonRpcErrorCodes.UpstreamUnavailable,
        message:
          condition + "the run may still be executing — do not retry blindly." + runHint,
        ...(runId !== undefined ? { data: { runId } } : {}),
      },
      id,
    };
  }
  // Local proxy bug mid-stream: generic message (stack to stderr at the catch
  // site); still include the run id when known — it is upstream-issued data
  // the client already saw, and it is the only recovery handle left.
  return {
    jsonrpc: "2.0",
    error: {
      code: JsonRpcErrorCodes.InternalError,
      message: "Internal error while relaying the upstream stream",
      ...(runId !== undefined ? { data: { runId } } : {}),
    },
    id,
  };
}
