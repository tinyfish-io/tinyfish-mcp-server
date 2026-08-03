/**
 * Session bridging state.
 *
 * With the raw-pipe architecture (spike decision B) the client re-sends
 * upstream's own Mcp-Session-Id, so localKey is normally the upstream-issued
 * id itself and the map's main job is abort tracking for in-flight upstream
 * fetches. The upstreamSessionId / protocolVersion fields are kept per the
 * Phase 3 contract regardless — they cost nothing and keep the door open for
 * a future stdio transport that needs real id bridging.
 *
 * Close is local-only cleanup: upstream has no DELETE handler
 * (00-shared-context §1), so teardown just aborts in-flight fetches and drops
 * the entry.
 *
 * Growth characteristic (deliberate): entries are created on first use and
 * removed only by close()/closeAll(). The raw-pipe HTTP surface has no
 * client-driven teardown signal (clients cannot DELETE), so a long-running
 * proxy accumulates one small entry per distinct session key until process
 * shutdown runs closeAll() via the shutdown hook. That is acceptable for a
 * local single-user proxy — entries are a few strings plus an empty Set — and
 * is the consciously chosen steady state. Phase 4 guidance: call
 * core.close(localKey) wherever the transport does learn of a session's end
 * (e.g. a future stdio transport's disconnect); an idle TTL can be added
 * later if a real leak ever materializes.
 */

export interface SessionEntry {
  /** Captured from the initialize response's Mcp-Session-Id header. */
  upstreamSessionId?: string;
  /** The client's MCP-Protocol-Version, replayed on subsequent calls. */
  protocolVersion?: string;
  /** AbortControllers for upstream fetches currently in flight. */
  readonly inflight: Set<AbortController>;
}

export class SessionStore {
  private readonly sessions = new Map<string, SessionEntry>();

  get size(): number {
    return this.sessions.size;
  }

  get(localKey: string): SessionEntry | undefined {
    return this.sessions.get(localKey);
  }

  has(localKey: string): boolean {
    return this.sessions.has(localKey);
  }

  /** Create-on-first-use lookup. */
  getOrCreate(localKey: string): SessionEntry {
    let entry = this.sessions.get(localKey);
    if (entry === undefined) {
      entry = { inflight: new Set() };
      this.sessions.set(localKey, entry);
    }
    return entry;
  }

  /**
   * Map an additional key to an existing entry. Used by initialize() to make
   * the upstream-issued Mcp-Session-Id resolve to the same session as the
   * initialize-time local key: with raw-pipe bridging the client re-sends
   * upstream's id, so later calls arrive keyed by that id.
   */
  alias(aliasKey: string, entry: SessionEntry): void {
    this.sessions.set(aliasKey, entry);
  }

  /**
   * Register a new in-flight upstream request for the session, creating the
   * session on first use. Pair with endRequest once the request settles.
   */
  beginRequest(localKey: string): AbortController {
    const controller = new AbortController();
    this.getOrCreate(localKey).inflight.add(controller);
    return controller;
  }

  /** Forget a settled request's controller (no-op if the session was closed). */
  endRequest(localKey: string, controller: AbortController): void {
    this.sessions.get(localKey)?.inflight.delete(controller);
  }

  /**
   * Local-only teardown: abort every in-flight upstream fetch for the session
   * and drop the entry — including every alias key that maps to the same
   * entry. No upstream DELETE — upstream has no DELETE handler.
   */
  close(localKey: string): void {
    const entry = this.sessions.get(localKey);
    if (entry === undefined) return;
    for (const [key, value] of this.sessions) {
      if (value === entry) this.sessions.delete(key);
    }
    for (const controller of entry.inflight) {
      controller.abort();
    }
    entry.inflight.clear();
  }

  /** Close every session (shutdown path). */
  closeAll(): void {
    for (const localKey of [...this.sessions.keys()]) {
      this.close(localKey);
    }
  }
}
