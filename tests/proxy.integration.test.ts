/**
 * Gated integration tests — the real local proxy against the real hosted
 * upstream (default https://agent.tinyfish.ai/mcp, override with
 * TINYFISH_UPSTREAM_URL).
 *
 * Run: TINYFISH_API_KEY=... npm run test:integration
 * Without the key the suite skips with a printed notice.
 *
 * Coverage when the key is set:
 * - tools/list via the proxy deep-equals a direct upstream tools/list (the
 *   parity guarantee made executable);
 * - one cheap tools/call (fetch_content) round-trips;
 * - one run_web_automation yields ≥1 progress notification then a final result.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listeningPort, postJson, sseDataPayloads } from "./helpers/http.js";
import { createProxyCore } from "../src/core/proxy-core.js";
import { createMcpAdapter } from "../src/http/adapter.js";
import { createAppHandler, startHttpServer } from "../src/http/index.js";
import { VERSION } from "../src/version.js";

const API_KEY = process.env.TINYFISH_API_KEY;
const UPSTREAM_URL = process.env.TINYFISH_UPSTREAM_URL ?? "https://agent.tinyfish.ai/mcp";

if (!API_KEY) {
  process.stderr.write(
    "\nproxy.integration: TINYFISH_API_KEY is not set — skipping the integration suite " +
      "(unit coverage runs offline via `npm test`).\n" +
      "Run with: TINYFISH_API_KEY=... npm run test:integration\n\n"
  );
}

const INITIALIZE_PARAMS = {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "tinyfish-mcp-integration", version: VERSION },
};

/** Direct upstream POST, bypassing the proxy — the parity baseline. */
async function postUpstream(
  body: unknown,
  sessionId?: string
): Promise<{ status: number; sessionId: string | null; json: unknown }> {
  const response = await fetch(UPSTREAM_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "X-API-Key": API_KEY as string,
      "X-TF-Request-Origin": "tinyfish-mcp",
      "X-TF-Client-Name": "tinyfish-mcp",
      "X-TF-Client-Version": VERSION,
      ...(sessionId !== undefined ? { "Mcp-Session-Id": sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    sessionId: response.headers.get("mcp-session-id"),
    json: JSON.parse(await response.text()),
  };
}

interface JsonRpcResponse {
  jsonrpc: string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
  id: unknown;
}

const describeWithApiKey = API_KEY ? describe.sequential : describe.skip;

describeWithApiKey("proxy integration (real hosted upstream)", () => {
  let server: Awaited<ReturnType<typeof startHttpServer>>;
  let mcpUrl: string;
  let sessionId: string;

  beforeAll(async () => {
    const core = createProxyCore({
      upstreamUrl: UPSTREAM_URL,
      apiKey: API_KEY as string,
      hooks: null,
    });
    server = await startHttpServer(0, createAppHandler(createMcpAdapter(core)));
    mcpUrl = `http://127.0.0.1:${listeningPort(server)}/mcp`;

    const init = await postJson(mcpUrl, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: INITIALIZE_PARAMS,
    });
    expect(init.status).toBe(200);
    const body = JSON.parse(init.text) as JsonRpcResponse;
    expect(body.error).toBeUndefined();
    // Upstream always answers 2025-11-25 regardless of the requested version.
    expect(body.result?.protocolVersion).toBe("2025-11-25");
    expect(init.sessionId).toBeTruthy();
    sessionId = init.sessionId as string;

    const notified = await postJson(
      mcpUrl,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { "Mcp-Session-Id": sessionId }
    );
    expect(notified.status).toBe(204);
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it(
    "tools/list via the proxy deep-equals a direct upstream tools/list",
    async () => {
      const viaProxy = await postJson(
        mcpUrl,
        { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
        { "Mcp-Session-Id": sessionId }
      );
      expect(viaProxy.status).toBe(200);
      const proxied = JSON.parse(viaProxy.text) as JsonRpcResponse;
      expect(proxied.error).toBeUndefined();

      // Direct baseline: its own upstream session, same request.
      const directInit = await postUpstream({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: INITIALIZE_PARAMS,
      });
      expect(directInit.status).toBe(200);
      const direct = await postUpstream(
        { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
        directInit.sessionId ?? undefined
      );
      expect(direct.status).toBe(200);

      // The parity guarantee: byte-order aside, the proxied answer IS the
      // upstream answer.
      expect(proxied.result).toEqual((direct.json as JsonRpcResponse).result);
      const tools = proxied.result?.tools as Array<{ name: string }>;
      expect(tools.length).toBeGreaterThan(0);
    },
    60_000
  );

  it(
    "a cheap tools/call (fetch_content) round-trips through the proxy",
    async () => {
      const result = await postJson(
        mcpUrl,
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: "fetch_content",
            // urls/format/links/image_links are all required by the tool schema.
            arguments: {
              urls: ["https://example.com"],
              format: "markdown",
              links: false,
              image_links: false,
            },
          },
        },
        { "Mcp-Session-Id": sessionId }
      );
      expect(result.status).toBe(200);
      const body = JSON.parse(result.text) as JsonRpcResponse;
      expect(body.error).toBeUndefined();
      expect(body.id).toBe(3);
      const content = body.result?.content as Array<{ type: string; text?: string }>;
      expect(Array.isArray(content)).toBe(true);
      expect(content.length).toBeGreaterThan(0);
    },
    120_000
  );

  it(
    "run_web_automation streams ≥1 progress notification then a final result",
    async () => {
      const response = await fetch(mcpUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Mcp-Session-Id": sessionId },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: {
            name: "run_web_automation",
            arguments: {
              url: "https://example.com",
              goal: "Read the page heading and report it.",
              // Required client-minted correlation id (a tool argument, not
              // the Mcp-Session-Id header).
              session_id: randomUUID(),
            },
            _meta: { progressToken: "integ-tok-4" },
          },
        }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      const payloads = sseDataPayloads(await response.text());
      expect(payloads.length).toBeGreaterThanOrEqual(2);

      const messages = payloads.map((p) => JSON.parse(p) as Record<string, unknown>);
      const progress = messages.filter((m) => m.method === "notifications/progress");
      expect(progress.length).toBeGreaterThanOrEqual(1);

      const final = messages[messages.length - 1] as unknown as JsonRpcResponse;
      expect(final.id).toBe(4);
      expect(final.result ?? final.error).toBeDefined();
      // A finished automation answers a CallToolResult (content array), even
      // for a failed run (isError true) — the stream must end with it.
      if (final.result !== undefined) {
        expect(Array.isArray(final.result.content)).toBe(true);
      }
    },
    600_000
  );
});

// Keep a visible, always-collected marker of the
// skip so a keyless run reports 1 passed test instead of "no tests found".
describe.skipIf(Boolean(API_KEY))("proxy integration (real hosted upstream)", () => {
  it("skips real upstream coverage when TINYFISH_API_KEY is not set", () => {
    expect(API_KEY).toBeFalsy();
  });
});
