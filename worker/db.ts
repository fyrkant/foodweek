/**
 * Meal and dish operations shared by the HTTP API and the MCP tools.
 * Invalid input throws InputError; anything else is a server error.
 */

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const MEAL_COLUMNS = "m.id, m.date, m.dish_id, d.name, d.recipe_url, d.notes, m.sort_order";
const DISH_COLUMNS = "id, name, recipe_url, notes";
const MAX_NAME = 200;
const MAX_URL = 2000;
const MAX_NOTES = 4000;

export class InputError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
  }
}

export interface DishRow {
  id: string;
  name: string;
  recipe_url: string | null;
  notes: string | null;
}

export interface MealRow extends Omit<DishRow, "id"> {
  id: number;
  date: string;
  dish_id: string;
  sort_order: number;
}

export type DishChoice = { dishId: string } | { name: string };

export interface DishPatch {
  name?: unknown;
  recipe_url?: unknown;
  notes?: unknown;
}

/** A real calendar date in YYYY-MM-DD form. */
export function isValidDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}

/** Absolute http(s) URL, or undefined if the value isn't one. */
function normalizeUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export async function getMeals(db: D1Database, start: string, end: string): Promise<MealRow[]> {
  const { results } = await db
    .prepare(
      `SELECT ${MEAL_COLUMNS} FROM meals m JOIN dishes d ON d.id = m.dish_id
       WHERE m.date >= ? AND m.date <= ? ORDER BY m.date, m.sort_order, m.id`,
    )
    .bind(start, end)
    .all<MealRow>();
  return results;
}

/** Plans a dish on a date, appended after that day's other meals. */
export async function addMeal(db: D1Database, date: string, choice: DishChoice): Promise<MealRow> {
  if (!isValidDate(date)) throw new InputError("Ogiltigt datum");
  const dishId = "dishId" in choice ? choice.dishId.trim().toLowerCase() : undefined;
  const name = "name" in choice ? choice.name.trim() : undefined;
  if (dishId !== undefined && !UUID_RE.test(dishId)) throw new InputError("Ogiltigt id");
  if (name !== undefined && (!name || name.length > MAX_NAME)) throw new InputError("Ogiltigt namn");

  // By id, else by name (case-insensitive), else create the dish.
  let dish = dishId
    ? await db.prepare(`SELECT ${DISH_COLUMNS} FROM dishes WHERE id = ?`).bind(dishId).first<DishRow>()
    : await db.prepare(`SELECT ${DISH_COLUMNS} FROM dishes WHERE name = ?`).bind(name).first<DishRow>();
  if (!dish && dishId) throw new InputError("Okänd maträtt", 404);
  if (!dish) {
    dish = await db
      .prepare(
        `INSERT INTO dishes (id, name) VALUES (?, ?)
         ON CONFLICT (name) DO UPDATE SET name = name
         RETURNING ${DISH_COLUMNS}`,
      )
      .bind(crypto.randomUUID(), name)
      .first<DishRow>();
    if (!dish) throw new Error("dish upsert returned no row");
  }

  const row = await db
    .prepare("SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM meals WHERE date = ?")
    .bind(date)
    .first<{ next: number }>();
  const sortOrder = row?.next ?? 0;

  const [inserted] = await db.batch<{ id: number }>([
    db
      .prepare("INSERT INTO meals (date, dish_id, sort_order) VALUES (?, ?, ?) RETURNING id")
      .bind(date, dish.id, sortOrder),
    db.prepare("UPDATE dishes SET uses = uses + 1 WHERE id = ?").bind(dish.id),
  ]);
  return {
    id: inserted.results[0].id,
    date,
    dish_id: dish.id,
    name: dish.name,
    recipe_url: dish.recipe_url,
    notes: dish.notes,
    sort_order: sortOrder,
  };
}

/** Returns false when no meal had that id. */
export async function deleteMeal(db: D1Database, id: number): Promise<boolean> {
  const result = await db.prepare("DELETE FROM meals WHERE id = ?").bind(id).run();
  return result.meta.changes > 0;
}

/** Writes explicit positions, e.g. after a drag and drop in the app. */
export async function setPositions(
  db: D1Database,
  items: { id: number; date: string; sort_order: number }[],
): Promise<void> {
  if (items.length === 0) return;
  const stmt = db.prepare("UPDATE meals SET date = ?, sort_order = ? WHERE id = ?");
  await db.batch(items.map((m) => stmt.bind(m.date, m.sort_order, m.id)));
}

/**
 * Moves a meal to a date, at a 0-based position among that day's meals
 * (default: last), and renumbers the days involved.
 */
export async function moveMeal(
  db: D1Database,
  id: number,
  date: string,
  position?: number,
): Promise<MealRow> {
  if (!isValidDate(date)) throw new InputError("Ogiltigt datum");
  const current = await db.prepare("SELECT date FROM meals WHERE id = ?").bind(id).first<{ date: string }>();
  if (!current) throw new InputError("Okänd middag", 404);

  const { results: target } = await db
    .prepare("SELECT id FROM meals WHERE date = ? AND id != ? ORDER BY sort_order, id")
    .bind(date, id)
    .all<{ id: number }>();
  const ids = target.map((m) => m.id);
  const index = position === undefined ? ids.length : Math.max(0, Math.min(position, ids.length));
  ids.splice(index, 0, id);

  const updates = ids.map((mealId, i) => ({ id: mealId, date, sort_order: i }));
  if (current.date !== date) {
    const { results: source } = await db
      .prepare("SELECT id FROM meals WHERE date = ? AND id != ? ORDER BY sort_order, id")
      .bind(current.date, id)
      .all<{ id: number }>();
    source.forEach((m, i) => updates.push({ id: m.id, date: current.date, sort_order: i }));
  }
  await setPositions(db, updates);

  const meal = await db
    .prepare(`SELECT ${MEAL_COLUMNS} FROM meals m JOIN dishes d ON d.id = m.dish_id WHERE m.id = ?`)
    .bind(id)
    .first<MealRow>();
  if (!meal) throw new Error("moved meal disappeared");
  return meal;
}

export async function listDishes(db: D1Database): Promise<DishRow[]> {
  const { results } = await db
    .prepare(`SELECT ${DISH_COLUMNS} FROM dishes ORDER BY uses DESC, name ASC`)
    .all<DishRow>();
  return results;
}

export interface DishSummary extends DishRow {
  times_planned: number;
  last_planned: string | null;
}

/** Dishes matching a name fragment (all when empty), most planned first. */
export async function searchDishes(
  db: D1Database,
  query: string,
  limit: number,
): Promise<DishSummary[]> {
  const like = `%${query.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const { results } = await db
    .prepare(
      `SELECT d.id, d.name, d.recipe_url, d.notes,
              COUNT(m.id) AS times_planned, MAX(m.date) AS last_planned
       FROM dishes d LEFT JOIN meals m ON m.dish_id = d.id
       WHERE d.name LIKE ? ESCAPE '\\'
       GROUP BY d.id
       ORDER BY times_planned DESC, d.name ASC
       LIMIT ?`,
    )
    .bind(like, limit)
    .all<DishSummary>();
  return results;
}

/** Updates a dish. Fields left out are unchanged; an empty recipe_url/notes clears it. */
export async function updateDish(db: D1Database, id: string, patch: DishPatch): Promise<DishRow> {
  id = id.toLowerCase();
  if (!UUID_RE.test(id)) throw new InputError("Ogiltigt id");

  const sets: string[] = [];
  const values: (string | null)[] = [];
  if (patch.name !== undefined) {
    const name = typeof patch.name === "string" ? patch.name.trim() : "";
    if (!name || name.length > MAX_NAME) throw new InputError("Ogiltigt namn");
    sets.push("name = ?");
    values.push(name);
  }
  if (patch.recipe_url !== undefined) {
    const raw = typeof patch.recipe_url === "string" ? patch.recipe_url.trim() : "";
    let url: string | null = null;
    if (raw) {
      const normalized = raw.length <= MAX_URL ? normalizeUrl(raw) : undefined;
      if (!normalized) throw new InputError("Länken måste börja med http:// eller https://");
      url = normalized;
    }
    sets.push("recipe_url = ?");
    values.push(url);
  }
  if (patch.notes !== undefined) {
    const notes = typeof patch.notes === "string" ? patch.notes.trim() : "";
    if (notes.length > MAX_NOTES) throw new InputError("Anteckningen är för lång");
    sets.push("notes = ?");
    values.push(notes || null);
  }
  if (sets.length === 0) throw new InputError("Inget att ändra");

  try {
    const dish = await db
      .prepare(`UPDATE dishes SET ${sets.join(", ")} WHERE id = ? RETURNING ${DISH_COLUMNS}`)
      .bind(...values, id)
      .first<DishRow>();
    if (!dish) throw new InputError("Okänd maträtt", 404);
    return dish;
  } catch (err) {
    if (err instanceof Error && !(err instanceof InputError) && /UNIQUE/i.test(err.message)) {
      throw new InputError("Det finns redan en maträtt med det namnet", 409);
    }
    throw err;
  }
}
