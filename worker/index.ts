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

api.get("/meals", async (c) => {
  const start = c.req.query("start");
  const end = c.req.query("end");
  if (!start || !end || !DATE_RE.test(start) || !DATE_RE.test(end)) {
    log("meals_get_bad_request", { start, end });
    return c.json({ error: "Ogiltigt datumintervall" }, 400);
  }
  try {
    const { results } = await c.env.DB.prepare(
      "SELECT id, date, name, sort_order FROM meals WHERE date >= ? AND date <= ? ORDER BY date, sort_order, id",
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
  const body = (await c.req.json().catch(() => ({}))) as { date?: string; name?: string };
  const date = body.date?.trim();
  const name = body.name?.trim();
  if (!date || !DATE_RE.test(date) || !name) {
    log("meals_post_bad_request", { date, hasName: Boolean(name) });
    return c.json({ error: "Datum och namn krävs" }, 400);
  }

  try {
    const row = await c.env.DB.prepare(
      "SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM meals WHERE date = ?",
    )
      .bind(date)
      .first<{ next: number }>();
    const sortOrder = row?.next ?? 0;

    const inserted = await c.env.DB.prepare(
      "INSERT INTO meals (date, name, sort_order) VALUES (?, ?, ?) RETURNING id, date, name, sort_order",
    )
      .bind(date, name, sortOrder)
      .first();

    // Remember the dinner for autocomplete.
    await c.env.DB.prepare(
      "INSERT INTO dinners (name, uses) VALUES (?, 1) ON CONFLICT(name) DO UPDATE SET uses = uses + 1",
    )
      .bind(name)
      .run();

    log("meals_post_ok", { date, name });
    return c.json({ meal: inserted }, 201);
  } catch (err) {
    logError("meals_post_failed", err, { date, name });
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

// --- Dinner catalog (autocomplete) -------------------------------------

api.get("/dinners", async (c) => {
  try {
    const { results } = await c.env.DB.prepare(
      "SELECT name FROM dinners ORDER BY uses DESC, name COLLATE NOCASE ASC",
    ).all<{ name: string }>();
    log("dinners_get_ok", { count: results.length });
    return c.json({ dinners: results.map((r) => r.name) });
  } catch (err) {
    logError("dinners_get_failed", err);
    return c.json({ error: "Kunde inte hämta middagar" }, 500);
  }
});

app.route("/api", api);

// Everything else: serve the static SPA assets.
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
