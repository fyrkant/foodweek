export interface Meal {
  id: number;
  date: string; // YYYY-MM-DD
  dish_id: string;
  name: string;
  recipe_url: string | null;
  notes: string | null;
  recipe_title: string | null;
  recipe_image: string | null;
  sort_order: number;
}

export interface Dish {
  id: string; // UUID
  name: string;
  recipe_url: string | null;
  notes: string | null;
  /** Preview of the recipe page, filled in by the server shortly after the link is saved. */
  recipe_title: string | null;
  recipe_image: string | null;
}

/** Fields to change on a dish; an empty string clears recipe_url/notes. */
export type DishPatch = Partial<{ name: string; recipe_url: string; notes: string }>;

/** An existing dish by id, or a new one by name. */
export type DishChoice = { dishId: string } | { name: string };

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    let message = `Fel (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* ignore */
    }
    const err = new Error(message) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return (await res.json()) as T;
}

export const api = {
  session: () => req<{ authenticated: boolean }>("/session"),
  login: (password: string) =>
    req<{ ok: true }>("/login", { method: "POST", body: JSON.stringify({ password }) }),
  logout: () => req<{ ok: true }>("/logout", { method: "POST" }),

  getMeals: (start: string, end: string) =>
    req<{ meals: Meal[] }>(`/meals?start=${start}&end=${end}`),
  addMeal: (date: string, dish: DishChoice) =>
    req<{ meal: Meal }>("/meals", { method: "POST", body: JSON.stringify({ date, ...dish }) }),
  deleteMeal: (id: number) => req<{ ok: true }>(`/meals/${id}`, { method: "DELETE" }),
  reorder: (meals: { id: number; date: string; sort_order: number }[]) =>
    req<{ ok: true }>("/meals/reorder", { method: "POST", body: JSON.stringify({ meals }) }),

  getDishes: () => req<{ dishes: Dish[] }>("/dishes"),
  updateDish: (id: string, patch: DishPatch) =>
    req<{ dish: Dish }>(`/dishes/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
};
