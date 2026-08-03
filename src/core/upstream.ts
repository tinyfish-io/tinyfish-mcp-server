/**
 * Single fetch call site for the upstream MCP endpoint.
 *
 * POSTs one JSON-RPC message per call with the auth + attribution headers and
 * classifies the response by HTTP status and content type only — it never
 * inspects methods, tool names, or result schemas. The upstream HTTP status is
 * preserved on every variant so the transport adapter can pass it through
 * (the hosted server answers JSON-RPC client errors as 400, server errors as
 * 500, notifications as 204).
 *
 * Web-standard types only (fetch / Response / ReadableStream) — no node:http.
 */
import { VERSION } from "../version.js";
import {
  isAbortError,
  UpstreamAbortedError,
  UpstreamAuthError,
  UpstreamProtocolError,
  UpstreamUnreachableError,
} from "./errors.js";

export type FetchLike = typeof globalThis.fetch;

export interface UpstreamClientOptions {
  /** Full upstream MCP URL, e.g. https://agent.tinyfish.ai/mcp */
  url: string;
  /** Sent as X-API-Key. Never logged. */
  apiKey: string;
  /** Sent as X-TF-Client-Version; defaults to the package version. */
  clientVersion?: string;
  /** Injectable fetch for tests; defaults to globalThis.fetch. */
  fetchFn?: FetchLike;
}

export interface UpstreamCallOptions {
  /** Replayed as Mcp-Session-Id when known. */
  sessionId?: string;
  /** Client's MCP-Protocol-Version, passed through when the client sent one. */
  protocolVersion?: string;
  /** Aborts the request and any in-progress body read. */
  signal?: AbortSignal;
}

/**
 * Response classification. Transport failures are not a variant — they are
 * thrown as typed errors (UpstreamUnreachableError / UpstreamAbortedError).
 */
export type UpstreamResponse =
  | {
      kind: "json";
      status: number;
      /** Mcp-Session-Id echoed by upstream (JSON responses only). */
      sessionId: string | null;
      /** The parsed JSON-RPC response, verbatim — success or error object. */
      body: unknown;
      /** Upstream's Content-Type header, verbatim (null if absent). */
      contentType: string | null;
    }
  | {
      kind: "sse";
      status: number;
      /** Raw upstream byte stream. Upstream SSE responses carry no session header. */
      stream: ReadableStream<Uint8Array>;
    }
  | {
      /** 204/empty body — upstream's answer to notifications. */
      kind: "empty";
      status: number;
    };

export class UpstreamClient {
  private readonly url: string;
  private readonly apiKey: string;
  private readonly clientVersion: string;
  private readonly fetchFn: FetchLike;

  constructor(options: UpstreamClientOptions) {
    this.url = options.url;
    this.apiKey = options.apiKey;
    this.clientVersion = options.clientVersion ?? VERSION;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
  }

  /** POST one JSON-RPC message upstream and classify the response. */
  async post(message: unknown, options: UpstreamCallOptions = {}): Promise<UpstreamResponse> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "X-API-Key": this.apiKey,
      "X-TF-Request-Origin": "tinyfish-mcp",
      "X-TF-Client-Name": "tinyfish-mcp",
      "X-TF-Client-Version": this.clientVersion,
    };
    if (options.sessionId !== undefined && options.sessionId !== "") {
      headers["Mcp-Session-Id"] = options.sessionId;
    }
    if (options.protocolVersion !== undefined && options.protocolVersion !== "") {
      headers["MCP-Protocol-Version"] = options.protocolVersion;
    }

    let response: Response;
    try {
      response = await this.fetchFn(this.url, {
        method: "POST",
        headers,
        body: JSON.stringify(message),
        signal: options.signal,
      });
    } catch (err) {
      throw toTransportError(err, this.url);
    }

    const status = response.status;
    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();

    if (status === 204 || status === 205) {
      return { kind: "empty", status };
    }

    if (contentType.startsWith("text/event-stream")) {
      if (response.body === null) {
        throw new UpstreamProtocolError("Upstream SSE response has no body", status);
      }
      return { kind: "sse", status, stream: response.body };
    }

    let text: string;
    try {
      text = await response.text();
    } catch (err) {
      throw toTransportError(err, this.url);
    }
    if (text.length === 0) {
      // A body-less 401/403 (e.g. a gateway/LB that strips bodies) is still an
      // auth rejection — classify it BEFORE the generic empty return so the
      // client gets the check-your-TINYFISH_API_KEY error, not a protocol one.
      if (status === 401 || status === 403) {
        throw new UpstreamAuthError(status, "");
      }
      return { kind: "empty", status };
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch (err) {
      // A 401/403 whose body is not JSON at all is an auth rejection
      // from an intermediary or a non-MCP error page — classified so the
      // adapter can shape the check-your-TINYFISH_API_KEY error. Any other
      // status with a non-JSON body stays a protocol violation.
      if (status === 401 || status === 403) {
        throw new UpstreamAuthError(status, text, { cause: err });
      }
      throw new UpstreamProtocolError(
        `Upstream returned non-JSON body (HTTP ${status}, content-type "${contentType}")`,
        status,
        { cause: err }
      );
    }
    // A 401/403 with a JSON body that is NOT a JSON-RPC message (e.g.
    // {"error":"unauthorized"}) is also an auth rejection — only a genuine
    // JSON-RPC error body forwards verbatim, preserving upstream's HTTP
    // status.
    if ((status === 401 || status === 403) && !isJsonRpcMessage(body)) {
      throw new UpstreamAuthError(status, text);
    }
    return {
      kind: "json",
      status,
      sessionId: response.headers.get("mcp-session-id"),
      body,
      contentType: response.headers.get("content-type"),
    };
  }
}

/**
 * A parsed body that is a JSON-RPC 2.0 message (forwardable verbatim): the
 * version marker plus at least one of the members every JSON-RPC message
 * carries (`result`/`error` for responses, `method` for requests and
 * notifications). Quasi-JSON-RPC junk like {"jsonrpc":"2.0","message":"no"}
 * fails the gate, so at 401/403 it shapes as the -32001 auth error instead of
 * forwarding.
 *
 * BATCH ARRAYS are deliberately outside this gate: MCP forbids JSON-RPC
 * batching and upstream does not support it, so a 401/403 whose body is a
 * batch(-error) array shapes as -32001 with the raw body preserved in
 * `data.upstreamBody` rather than forwarding verbatim.
 */
function isJsonRpcMessage(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    !Array.isArray(body) &&
    (body as { jsonrpc?: unknown }).jsonrpc === "2.0" &&
    ("error" in body || "result" in body || "method" in body)
  );
}

/**
 * Map a fetch/stream failure to a typed transport error. Never includes the
 * key. When `url` is given (the fetch call site knows it), the upstream host
 * is attached so the error shaping can name it in the client-facing message.
 */
export function toTransportError(
  err: unknown,
  url?: string
): UpstreamAbortedError | UpstreamUnreachableError {
  if (isAbortError(err)) {
    return new UpstreamAbortedError("Upstream request aborted", { cause: err });
  }
  // Undici wraps network failures as "TypeError: fetch failed" with the real
  // error (ECONNREFUSED, ENOTFOUND, TLS) on err.cause — surface that detail.
  let detail = err instanceof Error ? err.message : String(err);
  const cause = causeDetail(err);
  if (cause !== undefined) {
    detail += ` (${cause})`;
  }
  const error = new UpstreamUnreachableError(`Upstream unreachable: ${detail}`, { cause: err });
  if (url !== undefined) {
    try {
      error.host = new URL(url).host;
    } catch {
      // Malformed URL: leave host unset; the shaping falls back to a generic name.
    }
  }
  return error;
}

/** Extract the errno code (or message) from an error's cause chain, if any. */
function causeDetail(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !("cause" in err)) return undefined;
  const cause = (err as { cause: unknown }).cause;
  if (typeof cause !== "object" || cause === null) return undefined;
  const code = (cause as { code?: unknown }).code;
  if (typeof code === "string" && code.length > 0) return code;
  if (cause instanceof AggregateError) {
    for (const inner of cause.errors) {
      const innerCode = (inner as { code?: unknown } | null)?.code;
      if (typeof innerCode === "string" && innerCode.length > 0) return innerCode;
    }
  }
  if (cause instanceof Error && cause.message.length > 0) return cause.message;
  return undefined;
}
