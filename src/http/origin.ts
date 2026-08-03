/**
 * Pure Origin-header allowlist check — the anti-DNS-rebinding / anti-CSRF
 * control for the loopback server. Evaluated before the request body is read;
 * on deny the caller answers 403 without touching the body.
 *
 * Policy:
 * - Absent Origin → allow (non-browser clients: curl, MCP SDKs, inspectors).
 * - http/https origins on `127.0.0.1` or `localhost` → allow, any port
 *   (any port variant of loopback is fine, so no `port` parameter exists).
 * - Everything else → deny, including the literal "null" Origin (sandboxed
 *   iframes, file://), IPv6 `[::1]` (the server binds IPv4 loopback only),
 *   and anything that does not parse as a URL.
 */
export function checkOrigin(originHeader: string | undefined): boolean {
  if (originHeader === undefined) return true;
  let origin: URL;
  try {
    origin = new URL(originHeader);
  } catch {
    return false;
  }
  if (origin.protocol !== "http:" && origin.protocol !== "https:") return false;
  return origin.hostname === "127.0.0.1" || origin.hostname === "localhost";
}
