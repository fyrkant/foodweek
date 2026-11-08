import { OAuthProvider, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono, type Context } from "hono";
import {
  SESSION_COOKIE,
  clearSessionCookie,
  createSessionToken,
  readCookie,
  safeEqual,
  sessionCookie,
  verifySessionToken,
} from "./auth";
import {
  InputError,
  addMeal,
  deleteMeal,
  getMeals,
  isValidDate,
  listDishes,
  setPositions,
  updateDish,
  type DishPatch,
} from "./db";
import { buildCalendar } from "./ical";
import { handleMcp } from "./mcp";
import { handleAuthorize } from "./oauth";
import { parseAccent, renderWidget, stockholmToday, widgetWeek, type WidgetTheme } from "./widget";

interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  OAUTH_KV: KVNamespace;
  /** Injected by OAuthProvider into the default handler. */
  OAUTH_PROVIDER: OAuthHelpers;
  APP_PASSWORD: string;
  SESSION_SECRET: string;
  /** Canonical origin, e.g. https://foodweek.example.workers.dev; the MCP resource is PUBLIC_URL/mcp. */
  PUBLIC_URL: string;
}

type Variables = Record<string, never>;

/** Structured log helpers — everything goes to Cloudflare Workers Logs. */
function log(event: string, data?: Record<string, unknown>) {
  console.log(JSON.stringify({ level: "info", event, ...data }));
}

function logError(event: string, err: unknown, data?: Record<string, unknown>) {
  console.error(
    JSON.stringify({
      level: "error",
      event,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
      ...data,
    }),
  );
}

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// Request logger: one line per request with method, path, status and timing.
app.use("*", async (c, next) => {
  const start = Date.now();
  try {
    await next();
  } finally {
    log("request", {
      method: c.req.method,
      path: c.req.path,
      status: c.res?.status,
      ms: Date.now() - start,
    });
  }
});

// Log any unhandled error so it shows up in Cloudflare Workers Observability
// (Workers Logs), then return a clean JSON 500 to the client.
app.onError((err, c) => {
  logError("unhandled_error", err, { method: c.req.method, path: c.req.path });
  return c.json({ error: "Serverfel" }, 500);
});

const api = new Hono<{ Bindings: Env }>();

// --- Auth ---------------------------------------------------------------

api.post("/login", async (c) => {
  try {
    // Surface misconfiguration clearly instead of throwing a bare 500.
    if (!c.env.APP_PASSWORD || !c.env.SESSION_SECRET) {
      logError("login_misconfigured", "missing secret(s)", {
        APP_PASSWORD_set: Boolean(c.env.APP_PASSWORD),
        SESSION_SECRET_set: Boolean(c.env.SESSION_SECRET),
      });
      return c.json(
        { error: "Servern är inte konfigurerad (APP_PASSWORD/SESSION_SECRET saknas)" },
        500,
      );
    }

    const body = (await c.req.json().catch(() => ({}))) as { password?: string };
    const password = body.password;
    if (!password) {
      log("login_rejected", { reason: "no_password" });
      return c.json({ error: "Fel lösenord" }, 401);
    }
    if (!safeEqual(password, c.env.APP_PASSWORD)) {
      log("login_rejected", { reason: "wrong_password" });
      return c.json({ error: "Fel lösenord" }, 401);
    }

    const token = await createSessionToken(c.env.SESSION_SECRET);
    c.header("Set-Cookie", sessionCookie(token));
    log("login_ok");
    return c.json({ ok: true });
  } catch (err) {
    logError("login_failed", err);
    return c.json({ error: "Inloggning misslyckades (serverfel)" }, 500);
  }
});

api.post("/logout", (c) => {
  c.header("Set-Cookie", clearSessionCookie());
  log("logout");
  return c.json({ ok: true });
});

api.get("/session", async (c) => {
  try {
    if (!c.env.SESSION_SECRET) {
      logError("session_misconfigured", "missing SESSION_SECRET");
      return c.json({ authenticated: false });
    }
    const token = readCookie(c.req.header("Cookie") ?? null, SESSION_COOKIE);
    const authed = await verifySessionToken(token, c.env.SESSION_SECRET);
    return c.json({ authenticated: authed });
  } catch (err) {
    logError("session_check_failed", err);
    return c.json({ authenticated: false });
  }
});

// --- Calendar feed (Home Assistant, phone calendars) -------------------
// Public, read-only ICS feed: calendar clients can't log in.

const FEED_WEEKS_BACK = 8;
const FEED_WEEKS_AHEAD = 26;

api.get("/calendar.ics", async (c) => {
  const now = Date.now();
  const day = 24 * 3600 * 1000;
  const start = new Date(now - FEED_WEEKS_BACK * 7 * day).toISOString().slice(0, 10);
  const end = new Date(now + FEED_WEEKS_AHEAD * 7 * day).toISOString().slice(0, 10);
  try {
    const results = await getMeals(c.env.DB, start, end);
    log("calendar_ok", { count: results.length });
    return c.body(buildCalendar(results, new URL(c.req.url).hostname), 200, {
      "Content-Type": "text/calendar; charset=utf-8",
      "Cache-Control": "no-store",
    });
  } catch (err) {
    logError("calendar_failed", err);
    return c.text("Server error", 500);
  }
});

// Everything below requires a valid session.
api.use("/*", async (c, next) => {
  // login/logout/session are already handled above; guard the rest.
  const token = readCookie(c.req.header("Cookie") ?? null, SESSION_COOKIE);
  const authed = await verifySessionToken(token, c.env.SESSION_SECRET).catch((err) => {
    logError("auth_verify_failed", err, { path: c.req.path });
    return false;
  });
  if (!authed) {
    log("auth_rejected", { path: c.req.path });
    return c.json({ error: "Ej inloggad" }, 401);
  }
  await next();
});

// --- Meals --------------------------------------------------------------

function inputErrorResponse(c: Context, err: unknown, event: string, data?: Record<string, unknown>) {
  if (err instanceof InputError) {
    log(event + "_rejected", { ...data, reason: err.message });
    return c.json({ error: err.message }, err.status);
  }
  return undefined;
}

api.get("/meals", async (c) => {
  const start = c.req.query("start");
  const end = c.req.query("end");
  if (!isValidDate(start) || !isValidDate(end)) {
    log("meals_get_bad_request", { start, end });
    return c.json({ error: "Ogiltigt datumintervall" }, 400);
  }
  try {
    const meals = await getMeals(c.env.DB, start, end);
    log("meals_get_ok", { start, end, count: meals.length });
    return c.json({ meals });
  } catch (err) {
    logError("meals_get_failed", err, { start, end });
    return c.json({ error: "Kunde inte hämta middagar" }, 500);
  }
});

api.post("/meals", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    date?: unknown;
    dishId?: unknown;
    name?: unknown;
  };
  const date = typeof body.date === "string" ? body.date.trim() : "";
  const choice =
    typeof body.dishId === "string"
      ? { dishId: body.dishId }
      : typeof body.name === "string"
        ? { name: body.name }
        : undefined;
  if (!choice) {
    log("meals_post_bad_request", { date });
    return c.json({ error: "Datum och maträtt krävs" }, 400);
  }
  try {
    const meal = await addMeal(c.env.DB, date, choice);
    log("meals_post_ok", { date, dishId: meal.dish_id });
    return c.json({ meal }, 201);
  } catch (err) {
    return (
      inputErrorResponse(c, err, "meals_post", { date }) ??
      (logError("meals_post_failed", err, { date }), c.json({ error: "Kunde inte spara middagen" }, 500))
    );
  }
});

api.delete("/meals/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "Ogiltigt id" }, 400);
  try {
    await deleteMeal(c.env.DB, id);
    log("meals_delete_ok", { id });
    return c.json({ ok: true });
  } catch (err) {
    logError("meals_delete_failed", err, { id });
    return c.json({ error: "Kunde inte ta bort middagen" }, 500);
  }
});

api.post("/meals/reorder", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    meals?: { id: number; date: string; sort_order: number }[];
  };
  const items = body.meals;
  if (!Array.isArray(items)) return c.json({ error: "Ogiltig data" }, 400);

  const valid = items.filter(
    (m) => Number.isInteger(m.id) && isValidDate(m.date) && Number.isInteger(m.sort_order),
  );
  try {
    await setPositions(c.env.DB, valid);
    log("meals_reorder_ok", { count: valid.length });
    return c.json({ ok: true });
  } catch (err) {
    logError("meals_reorder_failed", err, { count: valid.length });
    return c.json({ error: "Kunde inte spara ordningen" }, 500);
  }
});

// --- Dish catalog (autocomplete) ----------------------------------------

api.get("/dishes", async (c) => {
  try {
    const dishes = await listDishes(c.env.DB);
    log("dishes_get_ok", { count: dishes.length });
    return c.json({ dishes });
  } catch (err) {
    logError("dishes_get_failed", err);
    return c.json({ error: "Kunde inte hämta maträtter" }, 500);
  }
});

// Edit a dish. Fields left out are unchanged; an empty recipe_url/notes clears it.
api.patch("/dishes/:id", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as DishPatch;
  try {
    const dish = await updateDish(c.env.DB, id, body);
    log("dish_patch_ok", { id });
    return c.json({ dish });
  } catch (err) {
    return (
      inputErrorResponse(c, err, "dish_patch", { id }) ??
      (logError("dish_patch_failed", err, { id }), c.json({ error: "Kunde inte spara maträtten" }, 500))
    );
  }
});

app.route("/api", api);

// Public, read-only week view for embedding (Home Assistant Webpage card).
// Must be listed in assets.run_worker_first in wrangler.jsonc, otherwise
// browser navigations get the SPA's index.html instead.
// ?theme=light|dark (default: follows the system), ?week=1 for next week,
// ?accent=FF9F0A to match a dashboard's accent colour.
app.get("/widget", async (c) => {
  const themeParam = c.req.query("theme");
  const theme: WidgetTheme = themeParam === "light" || themeParam === "dark" ? themeParam : "auto";
  const accent = parseAccent(c.req.query("accent"));
  const offset = Math.max(-52, Math.min(52, Math.trunc(Number(c.req.query("week") ?? 0)) || 0));

  const today = stockholmToday();
  const days = widgetWeek(today, offset);
  try {
    const results = await getMeals(c.env.DB, days[0], days[6]);
    log("widget_ok", { start: days[0], count: results.length });
    return c.html(renderWidget({
        days,
        meals: results,
        today,
        theme,
        accent,
        offset,
        refreshSeconds: 600,
        returnSeconds: 120,
      }), 200, {
      "Cache-Control": "no-store",
    });
  } catch (err) {
    logError("widget_failed", err);
    return c.text("Kunde inte hämta middagar", 500);
  }
});

// OAuth consent page for MCP clients such as Claude.
app.on(["GET", "POST"], "/authorize", (c) =>
  handleAuthorize(c.req.raw, c.env.OAUTH_PROVIDER, c.env.APP_PASSWORD),
);

// Everything else: serve the static SPA assets.
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

// --- MCP, behind OAuth --------------------------------------------------

const mcpHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const start = Date.now();
    try {
      const response = await handleMcp(request, env.DB);
      log("mcp", { method: request.method, status: response.status, ms: Date.now() - start });
      return response;
    } catch (err) {
      logError("mcp_failed", err, { method: request.method });
      return Response.json({ error: "Serverfel" }, { status: 500 });
    }
  },
};

let provider: { origin: string; instance: OAuthProvider<Env> } | undefined;

/** OAuthProvider needs the canonical public origin, which comes from env. */
function oauthProvider(env: Env): OAuthProvider<Env> {
  const origin = new URL(env.PUBLIC_URL).origin;
  if (provider?.origin !== origin) {
    provider = {
      origin,
      instance: new OAuthProvider<Env>({
        apiRoute: "/mcp",
        apiHandler: mcpHandler,
        defaultHandler: app as unknown as ExportedHandler<Env>,
        authorizeEndpoint: "/authorize",
        tokenEndpoint: "/token",
        clientRegistrationEndpoint: "/register",
        clientIdMetadataDocumentEnabled: true,
        scopesSupported: ["dinners"],
        requiredScopes: ["dinners"],
        resourceMetadata: {
          resource: `${origin}/mcp`,
          authorization_servers: [origin],
        },
      }),
    };
  }
  return provider.instance;
}

export default {
  fetch(request, env, ctx) {
    return oauthProvider(env).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
