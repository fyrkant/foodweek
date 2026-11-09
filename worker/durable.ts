import { DurableObject } from "cloudflare:workers";

/**
 * Fans out "the plan changed" to every open app and widget. One instance
 * for the household; sockets use the hibernation API, so idle connections
 * don't keep the object running.
 */
export class LiveUpdates extends DurableObject<Record<string, unknown>> {
  constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
    super(ctx, env);
    // Keepalive pings are answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Tells every connected client to refetch. Returns how many were told. */
  async broadcast(): Promise<number> {
    const message = JSON.stringify({ type: "changed", at: Date.now() });
    let sent = 0;
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(message);
        sent++;
      } catch {
        /* already closing */
      }
    }
    return sent;
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try {
      ws.close(code === 1005 ? 1000 : code);
    } catch {
      /* already closed */
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    try {
      ws.close(1011);
    } catch {
      /* already closed */
    }
  }
}

const IP_LIMIT = 5;
const IP_WINDOW_MS = 15 * 60 * 1000;
const GLOBAL_LIMIT = 20;
const GLOBAL_WINDOW_MS = 60 * 60 * 1000;

export interface LimitStatus {
  allowed: boolean;
  /** Seconds until another attempt is allowed. */
  retryAfter: number;
}

/**
 * Counts failed password attempts (app login and the OAuth consent page
 * share the password). Blocks an IP after IP_LIMIT failures in its window,
 * and everyone after GLOBAL_LIMIT failures in an hour.
 */
export class LoginLimiter extends DurableObject<Record<string, unknown>> {
  constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS failures (ip TEXT NOT NULL, at INTEGER NOT NULL)",
    );
    ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS failures_ip ON failures (ip, at)");
  }

  private oldest(where: string, since: number, ...params: (string | number)[]): { n: number; first: number | null } {
    return this.ctx.storage.sql
      .exec<{ n: number; first: number | null }>(
        `SELECT COUNT(*) AS n, MIN(at) AS first FROM failures WHERE at > ? ${where}`,
        since,
        ...params,
      )
      .one();
  }

  async check(ip: string): Promise<LimitStatus> {
    const now = Date.now();
    const byIp = this.oldest("AND ip = ?", now - IP_WINDOW_MS, ip);
    if (byIp.n >= IP_LIMIT && byIp.first !== null) {
      return { allowed: false, retryAfter: Math.ceil((byIp.first + IP_WINDOW_MS - now) / 1000) };
    }
    const all = this.oldest("", now - GLOBAL_WINDOW_MS);
    if (all.n >= GLOBAL_LIMIT && all.first !== null) {
      return { allowed: false, retryAfter: Math.ceil((all.first + GLOBAL_WINDOW_MS - now) / 1000) };
    }
    return { allowed: true, retryAfter: 0 };
  }

  async recordFailure(ip: string): Promise<void> {
    const now = Date.now();
    this.ctx.storage.sql.exec("DELETE FROM failures WHERE at <= ?", now - GLOBAL_WINDOW_MS);
    this.ctx.storage.sql.exec("INSERT INTO failures (ip, at) VALUES (?, ?)", ip, now);
  }

  /** A correct password clears that IP's failures (not the global count). */
  async recordSuccess(ip: string): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM failures WHERE ip = ?", ip);
  }
}
