# @tiny-fish/mcp

> **Status: pre-release.** Not yet published to npm — API-key authentication
> on the hosted server is still rolling out.

TinyFish local MCP server — a transparent reverse proxy that exposes a local
Streamable-HTTP MCP endpoint at `http://127.0.0.1:3711/mcp` and forwards every
request to the hosted TinyFish MCP server at `https://agent.tinyfish.ai/mcp`.

The proxy defines no tools and no schemas of its own. `tools/list`,
`tools/call`, `resources/*`, errors, and the `run_web_automation` SSE progress
stream all come from the hosted server: streaming (SSE) responses are relayed
byte-verbatim, and non-streaming JSON responses are relayed content-identical
(parsed and re-serialized, deep-equal to upstream). What the hosted server
says is what your client sees.

## Use the hosted server first

If your MCP client supports remote Streamable-HTTP servers (Claude Code,
Claude Desktop connectors, Cursor, VS Code, and most modern clients do),
connect it **directly** to the hosted server — no install, no local process:

```text
https://agent.tinyfish.ai/mcp
```

Use this package instead when:

- your client only talks to local MCP servers, or
- you want to authenticate with a **TinyFish API key** from your environment
  instead of the hosted server's OAuth flow (CI, headless machines, scripts).

## Install

```sh
npm install -g @tiny-fish/mcp
```

Or run it without installing:

```sh
npx @tiny-fish/mcp
```

Requires **Node.js >= 22**. (This is a deliberate deviation from the TinyFish
CLI's `>=24` requirement — nothing here needs Node 24.)

## API key

The server reads `TINYFISH_API_KEY` from its environment at startup and sends
it upstream as `X-API-Key` on every call. Get a key at
[https://agent.tinyfish.ai](https://agent.tinyfish.ai).

```sh
export TINYFISH_API_KEY=tf_...
tinyfish-mcp
```

On success it prints one line to stderr:

```text
tinyfish-mcp [info] listening on http://127.0.0.1:3711 — upstream https://agent.tinyfish.ai/mcp — v0.1.0
```

The key is never logged and never echoed back to clients.

## Client configuration

Start `tinyfish-mcp` (e.g. in a terminal, or under your process manager of
choice), then point your client at `http://127.0.0.1:3711/mcp`.

### Claude Code

```sh
claude mcp add --transport http tinyfish http://127.0.0.1:3711/mcp
```

### Claude Desktop

Settings → Connectors → Add custom connector, with URL
`http://127.0.0.1:3711/mcp`. On versions whose
`claude_desktop_config.json` supports URL-based servers:

```json
{
  "mcpServers": {
    "tinyfish": {
      "url": "http://127.0.0.1:3711/mcp"
    }
  }
}
```

Note: Claude Desktop can also use the hosted `https://agent.tinyfish.ai/mcp`
directly as a custom connector — prefer that unless you need API-key auth.

### Cursor

`~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

```json
{
  "mcpServers": {
    "tinyfish": {
      "url": "http://127.0.0.1:3711/mcp"
    }
  }
}
```

### VS Code

`.vscode/mcp.json`:

```json
{
  "servers": {
    "tinyfish": {
      "type": "http",
      "url": "http://127.0.0.1:3711/mcp"
    }
  }
}
```

### Any other client

Configure a Streamable-HTTP (remote/URL) MCP server with:

```json
{ "url": "http://127.0.0.1:3711/mcp" }
```

The endpoint accepts `POST /mcp` only (matching the hosted server, which has
no GET SSE channel and no DELETE session teardown). `GET /healthz` returns
`200 ok` for debugging.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `TINYFISH_API_KEY` | (required) | TinyFish API key, sent upstream as `X-API-Key`. The server refuses to start without it. |
| `PORT` | `3711` | Local listen port (integer 1-65535). No auto-increment: if the port is busy the server exits with an error. |
| `TINYFISH_UPSTREAM_URL` | `https://agent.tinyfish.ai/mcp` | Upstream MCP URL. Must be `https:`; `http:` is allowed only for `127.0.0.1`/`localhost` (local testing). |

The proxy also sends attribution headers on every upstream call:
`X-TF-Request-Origin: tinyfish-mcp`, `X-TF-Client-Name: tinyfish-mcp`, and
`X-TF-Client-Version: <package version>`.

## Security & trust model

This is a loopback-only server with a deliberate, documented trust boundary:

- **Loopback bind, always.** The server binds the `127.0.0.1` literal and this
  is not configurable — it can never listen on `0.0.0.0` or a LAN interface.
- **Origin validation.** Requests carrying an `Origin` header are rejected
  with `403` unless the origin is `http(s)://127.0.0.1` or
  `http(s)://localhost` (any port). This blocks the DNS-rebinding attack the
  MCP spec calls out for local HTTP servers. Requests without an `Origin`
  header (curl, MCP SDKs, inspectors) are allowed.
- **Server-holds-key.** The process reads `TINYFISH_API_KEY` from its env;
  clients send no credential on the local hop. This is the simplest model,
  but it means **any local process that can reach `127.0.0.1:<port>` can use
  your key and drive automations** (which can spend TinyFish credits). The
  loopback bind and Origin check are the mitigations; treat the port as a
  local trust boundary on a machine you trust.

## Troubleshooting

**"Port 3711 is already in use"** — another process holds the port. Stop it,
or set `PORT` to a free port and update your client config to match.

**HTTP 502 with JSON-RPC error `-32001`** ("Upstream rejected the request …
check that TINYFISH_API_KEY is set to a valid TinyFish API key") — the hosted
server rejected your key. Verify `TINYFISH_API_KEY` is set in the environment
of the `tinyfish-mcp` process (not just your shell) and that the key is valid
at [https://agent.tinyfish.ai](https://agent.tinyfish.ai). The error's `data`
carries the upstream status and (truncated) body for diagnosis.

**HTTP 502 with JSON-RPC error `-32000`** ("cannot reach …") — the upstream
server is unreachable: check your network/proxy/VPN; the hosted server may
also be temporarily down. If you overrode `TINYFISH_UPSTREAM_URL`, check it.
If a streamed `run_web_automation` call fails mid-stream you get the same
`-32000` as the final SSE frame, with a "the run may still be executing"
warning and the `runId` when known — check the run's status instead of
retrying blindly.

**Batch requests don't work** — MCP forbids JSON-RPC batching and the hosted
server does not support batch arrays. The proxy forwards a batch as-is and
the upstream answers its own error; send one JSON-RPC message per request.

**Claude/other client can't connect** — make sure `tinyfish-mcp` is actually
running (it's a standalone server; clients do not launch it) and that
`GET http://127.0.0.1:3711/healthz` answers `ok`.

## Development

```sh
npm ci
npm run build        # tsc → dist/, marks dist/index.js executable
npm test             # unit tests (offline, mock upstream)
npm run test:watch   # unit tests in watch mode
npm run lint         # eslint over src/ tests/
npm run format       # prettier
npm run type-check   # tsc --noEmit over the whole tree
```

Layout: `src/core/` is the transport-agnostic proxy core (upstream client,
session bridge, SSE relay, error shaping); `src/http/` is the thin HTTP
adapter (routing, Origin check); `tests/` holds the unit suites plus
`tests/helpers/mock-upstream.ts`, a mock of the hosted endpoint that the unit
tests run against entirely offline.

Integration tests hit the **real** hosted upstream and are gated: without
`TINYFISH_API_KEY` they skip with a printed notice.

```sh
TINYFISH_API_KEY=... npm run test:integration
```

Set `TINYFISH_UPSTREAM_URL` to point them at a sandbox deployment instead of
production. Note the `run_web_automation` integration test executes a real
automation and spends credits.

## Maintenance

Maintained by [@Zechereh](https://github.com/Zechereh). Bugs and feature
requests: [GitHub issues](https://github.com/tinyfish-io/tinyfish-mcp-server/issues).

## License

MIT
