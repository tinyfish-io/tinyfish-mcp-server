import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { log } from "../log.js";
import { checkOrigin } from "./origin.js";

/**
 * Request handler contract for the HTTP layer. Handlers may be async: the
 * server awaits the returned promise and converts a rejection into a 500
 * JSON-RPC InternalError response (or just ends the response when headers are
 * already out, e.g. mid-SSE), so async failures are never silently swallowed
 * (Phase 2 review note). Phase 6 refines the error shaping.
 */
export type RequestHandler = (
  req: IncomingMessage,
  res: ServerResponse
) => void | Promise<void>;

/** JSON-RPC InternalError, used for unhandled handler failures. */
const INTERNAL_ERROR = -32603;

const notFoundHandler: RequestHandler = (_req, res) => {
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found\n");
};

/**
 * Routing shell around the MCP adapter:
 * - Origin allowlist first, before the body is touched: deny → 403 plain text.
 * - GET /healthz → 200 "ok" (client debugging; kept trivial).
 * - POST /mcp → the MCP handler; other methods on /mcp → 405 with Allow: POST
 *   (mirrors upstream, where Next.js 405s methods the route does not export).
 * - Everything else → 404.
 */
export function createAppHandler(mcpHandler: RequestHandler): RequestHandler {
  return async (req, res) => {
    if (!checkOrigin(req.headers.origin)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden: Origin not allowed\n");
      return;
    }
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname === "/mcp") {
      if (req.method !== "POST") {
        res.writeHead(405, { Allow: "POST" });
        res.end();
        return;
      }
      await mcpHandler(req, res);
      return;
    }
    if (pathname === "/healthz" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      return;
    }
    notFoundHandler(req, res);
  };
}

/**
 * Starts an HTTP server bound to 127.0.0.1 (loopback only, never configurable).
 * Resolves once listening; rejects with the bind error (e.g. EADDRINUSE) otherwise.
 */
export function startHttpServer(
  port: number,
  handler: RequestHandler = notFoundHandler
): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      void invokeSafely(handler, req, res);
    });
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve(server);
    });
  });
}

/**
 * Await the handler; turn sync throws and async rejections into a 500. With
 * Phase 6 the MCP adapter shapes every classified failure itself, so anything
 * that reaches this catch is a local proxy bug: full stack to stderr, generic
 * -32603 InternalError to the client.
 */
async function invokeSafely(
  handler: RequestHandler,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  try {
    await handler(req, res);
  } catch (err) {
    // Core error messages never contain the API key (Phase 3 invariant), and
    // the client-facing body is generic regardless — the key cannot leak.
    log.error(
      `request failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`
    );
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: INTERNAL_ERROR, message: "Internal error" },
          id: null,
        })
      );
    } else {
      res.end();
    }
  }
}
