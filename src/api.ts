export interface Meal {
  id: number;
  date: string; // YYYY-MM-DD
  name: string;
  sort_order: number;
}

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
  addMeal: (date: string, name: string) =>
    req<{ meal: Meal }>("/meals", { method: "POST", body: JSON.stringify({ date, name }) }),
  deleteMeal: (id: number) => req<{ ok: true }>(`/meals/${id}`, { method: "DELETE" }),
  reorder: (meals: { id: number; date: string; sort_order: number }[]) =>
    req<{ ok: true }>("/meals/reorder", { method: "POST", body: JSON.stringify({ meals }) }),

  getDinners: () => req<{ dinners: string[] }>("/dinners"),
};
