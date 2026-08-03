#!/usr/bin/env node
import { ConfigError, parseConfig } from "./config.js";
import { createProxyCore } from "./core/proxy-core.js";
import { createMcpAdapter } from "./http/adapter.js";
import { createAppHandler, startHttpServer } from "./http/index.js";
import { log } from "./log.js";
import { shutdownHooks } from "./shutdown.js";
import { VERSION } from "./version.js";

function isErrnoException(err: unknown): err is Error & { code?: string } {
  return err instanceof Error && "code" in err;
}

async function main(): Promise<void> {
  let config;
  try {
    config = parseConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  // The real MCP handler: origin/routing shell → adapter → proxy core.
  // createProxyCore registers session teardown into shutdownHooks itself.
  const core = createProxyCore({ upstreamUrl: config.upstreamUrl, apiKey: config.apiKey });
  const handler = createAppHandler(createMcpAdapter(core));

  let server;
  try {
    server = await startHttpServer(config.port, handler);
  } catch (err) {
    if (isErrnoException(err) && err.code === "EADDRINUSE") {
      log.error(
        `Port ${config.port} is already in use — stop the other process or set PORT to a free port`
      );
      process.exit(1);
    }
    throw err;
  }

  // The one startup line. Never include config.apiKey here or in any other log call.
  log.info(
    `listening on http://127.0.0.1:${config.port} — upstream ${config.upstreamUrl} — v${VERSION}`
  );

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close();
    for (const hook of shutdownHooks) {
      try {
        await hook();
      } catch (err) {
        log.error(`shutdown hook failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err: unknown) => {
  log.error(`startup failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
