import { Hono } from "hono";
import {
  SESSION_COOKIE,
  clearSessionCookie,
  createSessionToken,
  readCookie,
  safeEqual,
  sessionCookie,
  verifySessionToken,
} from "./auth";
import { buildCalendar, type FeedMeal } from "./ical";
import { parseAccent, renderWidget, stockholmToday, widgetWeek, type WidgetTheme } from "./widget";

interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  APP_PASSWORD: string;
  SESSION_SECRET: string;
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
    const { results } = await c.env.DB.prepare(
      `SELECT m.id, m.date, d.name, d.recipe_url, d.notes FROM meals m JOIN dishes d ON d.id = m.dish_id
       WHERE m.date >= ? AND m.date <= ? ORDER BY m.date, m.sort_order, m.id`,
    )
      .bind(start, end)
      .all<FeedMeal>();
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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MEAL_COLUMNS = "m.id, m.date, m.dish_id, d.name, d.recipe_url, d.notes, m.sort_order";
const DISH_COLUMNS = "id, name, recipe_url, notes";
const MAX_NAME = 200;
const MAX_URL = 2000;
const MAX_NOTES = 4000;

/** Absolute http(s) URL, or undefined if the value isn't one. */
function normalizeUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

interface DishRow {
  id: string;
  name: string;
  recipe_url: string | null;
  notes: string | null;
}

api.get("/meals", async (c) => {
  const start = c.req.query("start");
  const end = c.req.query("end");
  if (!start || !end || !DATE_RE.test(start) || !DATE_RE.test(end)) {
    log("meals_get_bad_request", { start, end });
    return c.json({ error: "Ogiltigt datumintervall" }, 400);
  }
  try {
    const { results } = await c.env.DB.prepare(
      `SELECT ${MEAL_COLUMNS} FROM meals m JOIN dishes d ON d.id = m.dish_id
       WHERE m.date >= ? AND m.date <= ? ORDER BY m.date, m.sort_order, m.id`,
    )
      .bind(start, end)
      .all();
    log("meals_get_ok", { start, end, count: results.length });
    return c.json({ meals: results });
  } catch (err) {
    logError("meals_get_failed", err, { start, end });
    return c.json({ error: "Kunde inte hämta middagar" }, 500);
  }
});

api.post("/meals", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    date?: string;
    dishId?: string;
    name?: string;
  };
  const date = body.date?.trim();
  const dishId = body.dishId?.trim().toLowerCase();
  const name = body.name?.trim();
  if (!date || !DATE_RE.test(date) || !(dishId ? UUID_RE.test(dishId) : name)) {
    log("meals_post_bad_request", { date, dishId, hasName: Boolean(name) });
    return c.json({ error: "Datum och maträtt krävs" }, 400);
  }

  try {
    // Resolve the dish: by id, else by name (case-insensitive), else create it.
    let dish = dishId
      ? await c.env.DB.prepare(`SELECT ${DISH_COLUMNS} FROM dishes WHERE id = ?`)
          .bind(dishId)
          .first<DishRow>()
      : await c.env.DB.prepare(`SELECT ${DISH_COLUMNS} FROM dishes WHERE name = ?`)
          .bind(name)
          .first<DishRow>();
    if (!dish && dishId) {
      log("meals_post_unknown_dish", { dishId });
      return c.json({ error: "Okänd maträtt" }, 404);
    }
    if (!dish) {
      dish = await c.env.DB.prepare(
        `INSERT INTO dishes (id, name) VALUES (?, ?)
         ON CONFLICT (name) DO UPDATE SET name = name
         RETURNING ${DISH_COLUMNS}`,
      )
        .bind(crypto.randomUUID(), name)
        .first<DishRow>();
      if (!dish) throw new Error("dish upsert returned no row");
    }

    const row = await c.env.DB.prepare(
      "SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM meals WHERE date = ?",
    )
      .bind(date)
      .first<{ next: number }>();
    const sortOrder = row?.next ?? 0;

    const [inserted] = await c.env.DB.batch<{ id: number }>([
      c.env.DB.prepare(
        "INSERT INTO meals (date, dish_id, sort_order) VALUES (?, ?, ?) RETURNING id",
      ).bind(date, dish.id, sortOrder),
      c.env.DB.prepare("UPDATE dishes SET uses = uses + 1 WHERE id = ?").bind(dish.id),
    ]);
    const meal = {
      id: inserted.results[0].id,
      date,
      dish_id: dish.id,
      name: dish.name,
      recipe_url: dish.recipe_url,
      notes: dish.notes,
      sort_order: sortOrder,
    };

    log("meals_post_ok", { date, dishId: dish.id });
    return c.json({ meal }, 201);
  } catch (err) {
    logError("meals_post_failed", err, { date, dishId, name });
    return c.json({ error: "Kunde inte spara middagen" }, 500);
  }
});

api.delete("/meals/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "Ogiltigt id" }, 400);
  try {
    await c.env.DB.prepare("DELETE FROM meals WHERE id = ?").bind(id).run();
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
    (m) =>
      Number.isInteger(m.id) &&
      typeof m.date === "string" &&
      DATE_RE.test(m.date) &&
      Number.isInteger(m.sort_order),
  );
  if (valid.length === 0) return c.json({ ok: true });

  try {
    const stmt = c.env.DB.prepare("UPDATE meals SET date = ?, sort_order = ? WHERE id = ?");
    await c.env.DB.batch(valid.map((m) => stmt.bind(m.date, m.sort_order, m.id)));
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
    const { results } = await c.env.DB.prepare(
      `SELECT ${DISH_COLUMNS} FROM dishes ORDER BY uses DESC, name ASC`,
    ).all<DishRow>();
    log("dishes_get_ok", { count: results.length });
    return c.json({ dishes: results });
  } catch (err) {
    logError("dishes_get_failed", err);
    return c.json({ error: "Kunde inte hämta maträtter" }, 500);
  }
});

// Edit a dish. Fields left out are unchanged; an empty recipe_url/notes clears it.
api.patch("/dishes/:id", async (c) => {
  const id = c.req.param("id").toLowerCase();
  if (!UUID_RE.test(id)) return c.json({ error: "Ogiltigt id" }, 400);
  const body = (await c.req.json().catch(() => ({}))) as {
    name?: unknown;
    recipe_url?: unknown;
    notes?: unknown;
  };

  const sets: string[] = [];
  const values: (string | null)[] = [];
  if (body.name !== undefined) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > MAX_NAME) return c.json({ error: "Ogiltigt namn" }, 400);
    sets.push("name = ?");
    values.push(name);
  }
  if (body.recipe_url !== undefined) {
    const raw = typeof body.recipe_url === "string" ? body.recipe_url.trim() : "";
    let url: string | null = null;
    if (raw) {
      const normalized = raw.length <= MAX_URL ? normalizeUrl(raw) : undefined;
      if (!normalized) return c.json({ error: "Länken måste börja med http:// eller https://" }, 400);
      url = normalized;
    }
    sets.push("recipe_url = ?");
    values.push(url);
  }
  if (body.notes !== undefined) {
    const notes = typeof body.notes === "string" ? body.notes.trim() : "";
    if (notes.length > MAX_NOTES) return c.json({ error: "Anteckningen är för lång" }, 400);
    sets.push("notes = ?");
    values.push(notes || null);
  }
  if (sets.length === 0) return c.json({ error: "Inget att ändra" }, 400);

  try {
    const dish = await c.env.DB.prepare(
      `UPDATE dishes SET ${sets.join(", ")} WHERE id = ? RETURNING ${DISH_COLUMNS}`,
    )
      .bind(...values, id)
      .first<DishRow>();
    if (!dish) return c.json({ error: "Okänd maträtt" }, 404);
    log("dish_patch_ok", { id, fields: sets.length });
    return c.json({ dish });
  } catch (err) {
    if (err instanceof Error && /UNIQUE/i.test(err.message)) {
      log("dish_patch_conflict", { id });
      return c.json({ error: "Det finns redan en maträtt med det namnet" }, 409);
    }
    logError("dish_patch_failed", err, { id });
    return c.json({ error: "Kunde inte spara maträtten" }, 500);
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
    const { results } = await c.env.DB.prepare(
      `SELECT m.date, d.name, d.recipe_url FROM meals m JOIN dishes d ON d.id = m.dish_id
       WHERE m.date >= ? AND m.date <= ? ORDER BY m.date, m.sort_order, m.id`,
    )
      .bind(days[0], days[6])
      .all<{ date: string; name: string; recipe_url: string | null }>();
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

// Everything else: serve the static SPA assets.
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
