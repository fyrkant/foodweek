/**
 * Work that follows a change: telling open clients to refetch and fetching
 * recipe previews. Both run after the response via waitUntil and never
 * fail the request that triggered them.
 */

import type { LiveUpdates, LoginLimiter } from "./durable";
import { refreshDishPreview } from "./preview";

export interface EffectsEnv {
  DB: D1Database;
  LIVE: DurableObjectNamespace<LiveUpdates>;
  LOGIN_LIMITER: DurableObjectNamespace<LoginLimiter>;
}

export interface Effects {
  /** The plan or a dish changed. */
  changed(): void;
  /** A dish's recipe link changed (or has no preview yet). */
  refreshPreview(dishId: string): void;
}

function logFailure(event: string, err: unknown, data?: Record<string, unknown>) {
  console.error(
    JSON.stringify({ level: "error", event, error: err instanceof Error ? err.message : String(err), ...data }),
  );
}

export function liveStub(env: EffectsEnv) {
  return env.LIVE.get(env.LIVE.idFromName("household"));
}

export function loginLimiter(env: EffectsEnv) {
  return env.LOGIN_LIMITER.get(env.LOGIN_LIMITER.idFromName("password"));
}

export function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

export function effects(env: EffectsEnv, ctx: ExecutionContext): Effects {
  const broadcast = () => liveStub(env).broadcast();
  return {
    changed() {
      ctx.waitUntil(broadcast().catch((err) => logFailure("live_broadcast_failed", err)));
    },
    refreshPreview(dishId) {
      ctx.waitUntil(
        refreshDishPreview(env.DB, dishId)
          .then((stored) => (stored ? broadcast() : 0))
          .catch((err) => logFailure("recipe_preview_store_failed", err, { dishId })),
      );
    },
  };
}
