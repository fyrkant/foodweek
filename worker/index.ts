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

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const api = new Hono<{ Bindings: Env }>();

// --- Auth ---------------------------------------------------------------

api.post("/login", async (c) => {
  const { password } = await c.req.json<{ password?: string }>().catch(() => ({
    password: undefined,
  }));
  if (!password || !safeEqual(password, c.env.APP_PASSWORD)) {
    return c.json({ error: "Fel lösenord" }, 401);
  }
  const token = await createSessionToken(c.env.SESSION_SECRET);
  c.header("Set-Cookie", sessionCookie(token));
  return c.json({ ok: true });
});

api.post("/logout", (c) => {
  c.header("Set-Cookie", clearSessionCookie());
  return c.json({ ok: true });
});

api.get("/session", async (c) => {
  const token = readCookie(c.req.header("Cookie") ?? null, SESSION_COOKIE);
  const authed = await verifySessionToken(token, c.env.SESSION_SECRET);
  return c.json({ authenticated: authed });
});

// Everything below requires a valid session.
api.use("/*", async (c, next) => {
  // login/logout/session are already handled above; guard the rest.
  const token = readCookie(c.req.header("Cookie") ?? null, SESSION_COOKIE);
  const authed = await verifySessionToken(token, c.env.SESSION_SECRET);
  if (!authed) return c.json({ error: "Ej inloggad" }, 401);
  await next();
});

// --- Meals --------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

api.get("/meals", async (c) => {
  const start = c.req.query("start");
  const end = c.req.query("end");
  if (!start || !end || !DATE_RE.test(start) || !DATE_RE.test(end)) {
    return c.json({ error: "Ogiltigt datumintervall" }, 400);
  }
  const { results } = await c.env.DB.prepare(
    "SELECT id, date, name, sort_order FROM meals WHERE date >= ? AND date <= ? ORDER BY date, sort_order, id",
  )
    .bind(start, end)
    .all();
  return c.json({ meals: results });
});

api.post("/meals", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { date?: string; name?: string };
  const date = body.date?.trim();
  const name = body.name?.trim();
  if (!date || !DATE_RE.test(date) || !name) {
    return c.json({ error: "Datum och namn krävs" }, 400);
  }

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

  return c.json({ meal: inserted }, 201);
});

api.delete("/meals/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "Ogiltigt id" }, 400);
  await c.env.DB.prepare("DELETE FROM meals WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
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

  const stmt = c.env.DB.prepare(
    "UPDATE meals SET date = ?, sort_order = ? WHERE id = ?",
  );
  await c.env.DB.batch(valid.map((m) => stmt.bind(m.date, m.sort_order, m.id)));
  return c.json({ ok: true });
});

// --- Dinner catalog (autocomplete) -------------------------------------

api.get("/dinners", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT name FROM dinners ORDER BY uses DESC, name COLLATE NOCASE ASC",
  ).all<{ name: string }>();
  return c.json({ dinners: results.map((r) => r.name) });
});

app.route("/api", api);

// Everything else: serve the static SPA assets.
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
