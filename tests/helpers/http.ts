/**
 * Shared test helpers for suites that drive the FULL local proxy over real
 * HTTP (client → 127.0.0.1 server → proxy core → mock upstream). Deduplicated
 * from adapter/relay/errors suites in Phase 7 — fixture builders live in
 * ./mock-upstream.ts; scripted-fetch helpers stay local to the suites that
 * shape them differently.
 */
import type { Server } from "node:http";

/** The bound port of a listening server (tests always listen on port 0). */
export function listeningPort(server: Server): number {
  const address = server.address();
  if (typeof address === "object" && address !== null) return address.port;
  throw new Error("server has no address");
}

export interface PostResult {
  status: number;
  contentType: string;
  /** Mcp-Session-Id response header, null when absent. */
  sessionId: string | null;
  /** Raw response body text (for byte-verbatim assertions). */
  text: string;
  headers: Headers;
}

/** Raw request sender — method/body/headers exactly as given. */
export async function send(
  url: string,
  init: { method?: string; body?: string; headers?: Record<string, string> } = {}
): Promise<PostResult> {
  const response = await fetch(url, {
    method: init.method ?? "POST",
    headers: init.headers ?? {},
    body: init.body,
  });
  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
    sessionId: response.headers.get("mcp-session-id"),
    text: await response.text(),
    headers: response.headers,
  };
}

/** POST a JSON body and read the whole response (raw text preserved). */
export function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<PostResult> {
  return send(url, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** Parse the `data:` payload strings out of an SSE body, in order, one per frame. */
export function sseDataPayloads(text: string): string[] {
  const payloads: string[] = [];
  for (const frame of text.split("\n\n")) {
    const dataLines: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    if (dataLines.length > 0) payloads.push(dataLines.join("\n"));
  }
  return payloads;
}

/** A tools/call of run_web_automation with optional mock knobs in arguments. */
export function automationCall(
  id: number,
  args: Record<string, unknown>,
  progressToken?: string
): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name: "run_web_automation",
      arguments: { goal: "extract mock data", ...args },
      ...(progressToken !== undefined ? { _meta: { progressToken } } : {}),
    },
  };
}

/** A Response with a JSON body (scripted/injected-fetch suites). */
export function jsonResponse(
  body: unknown,
  { status = 200, headers = {} }: { status?: number; headers?: Record<string, string> } = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}
