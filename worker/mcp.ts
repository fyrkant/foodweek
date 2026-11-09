/**
 * MCP server exposing the dinner plan as tools. Stateless: a fresh server
 * and transport per request, behind the OAuth provider (see index.ts).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import {
  WEEKDAYS_SV,
  addDays,
  formatSpan,
  isoWeekNumber,
  parseDate,
  startOfWeek,
  toDateStr,
  weekDays,
} from "../src/dates";
import { holidayFor } from "../src/holidays";
import {
  InputError,
  addMeal,
  deleteMeal,
  getMeals,
  isValidDate,
  moveMeal,
  searchDishes,
  updateDish,
  type MealRow,
} from "./db";
import type { Effects } from "./effects";
import { stockholmToday } from "./widget";

const INSTRUCTIONS = `foodweek is a household's weekly dinner planner (Swedish; weeks run Monday to Sunday, ISO week numbers, dates are YYYY-MM-DD in Europe/Stockholm).
Each day can hold several dinners in order. A dinner is a planned meal pointing to a dish; dishes are reused across weeks and may have a recipe link and notes.
Before planning, call search_dishes to reuse an existing dish (pass its dish_id) instead of creating a near-duplicate name. get_recent_dinners helps avoid repeats.
Swedish holidays and eves (julafton, midsommarafton, …) are included in get_week.
Write tools change the household's real plan immediately: confirm with the user before larger changes such as clearing or rearranging a whole week.`;

const date = z.string().describe("Date as YYYY-MM-DD");

function weekday(dateStr: string): string {
  return WEEKDAYS_SV[(parseDate(dateStr).getUTCDay() + 6) % 7];
}

function dinner(m: MealRow) {
  return {
    meal_id: m.id,
    dish_id: m.dish_id,
    name: m.name,
    ...(m.recipe_url ? { recipe_url: m.recipe_url } : {}),
    ...(m.recipe_title ? { recipe_title: m.recipe_title } : {}),
    ...(m.notes ? { notes: m.notes } : {}),
  };
}

function ok(result: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
}

/** Turns invalid input into a tool error the model can read and fix. */
async function run(fn: () => Promise<unknown>) {
  try {
    return ok(await fn());
  } catch (err) {
    if (err instanceof InputError) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
    }
    throw err;
  }
}

function buildServer(db: D1Database, fx: Effects): McpServer {
  const server = new McpServer(
    { name: "foodweek", version: "1.0.0" },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    "get_week",
    {
      title: "Get week plan",
      description:
        "Dinners planned for one week (Monday–Sunday), with Swedish holidays. Defaults to the current week.",
      inputSchema: {
        date: date.optional().describe("Any date in the wanted week. Takes precedence over week_offset."),
        week_offset: z.number().int().min(-52).max(52).optional().describe("Weeks from the current week, e.g. 1 for next week"),
      },
      annotations: { readOnlyHint: true },
    },
    ({ date, week_offset }) =>
      run(async () => {
        if (date !== undefined && !isValidDate(date)) throw new InputError("Invalid date, use YYYY-MM-DD");
        const today = stockholmToday();
        const anchor = date ? parseDate(date) : addDays(parseDate(today), (week_offset ?? 0) * 7);
        const monday = startOfWeek(anchor);
        const days = weekDays(monday);
        const meals = await getMeals(db, days[0], days[6]);
        return {
          week: isoWeekNumber(monday),
          span: formatSpan(monday),
          today,
          days: days.map((d) => {
            const holiday = holidayFor(d);
            return {
              date: d,
              weekday: weekday(d),
              ...(d === today ? { is_today: true } : {}),
              ...(holiday ? { holiday: holiday.name, red_day: holiday.red } : {}),
              dinners: meals.filter((m) => m.date === d).map(dinner),
            };
          }),
        };
      }),
  );

  server.registerTool(
    "get_recent_dinners",
    {
      title: "Get recent dinners",
      description: "Dinners from the last few weeks up to today, and which dishes came up most. Useful for variety.",
      inputSchema: {
        weeks: z.number().int().min(1).max(26).default(4).describe("How many weeks back to look"),
      },
      annotations: { readOnlyHint: true },
    },
    ({ weeks }) =>
      run(async () => {
        const to = stockholmToday();
        const from = toDateStr(addDays(parseDate(to), -7 * weeks));
        const meals = await getMeals(db, from, to);
        const counts = new Map<string, number>();
        for (const m of meals) counts.set(m.name, (counts.get(m.name) ?? 0) + 1);
        return {
          from,
          to,
          dinners: meals.map((m) => ({ date: m.date, weekday: weekday(m.date), name: m.name })),
          most_planned: [...counts]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([name, count]) => ({ name, count })),
        };
      }),
  );

  server.registerTool(
    "search_dishes",
    {
      title: "Search dishes",
      description:
        "The household's known dishes matching a name fragment (case-insensitive), most planned first, with recipe link, notes and when last planned. Leave query empty to list them all.",
      inputSchema: {
        query: z.string().max(200).default(""),
        limit: z.number().int().min(1).max(200).default(50),
      },
      annotations: { readOnlyHint: true },
    },
    ({ query, limit }) => run(async () => ({ dishes: await searchDishes(db, query, limit) })),
  );

  server.registerTool(
    "plan_dinner",
    {
      title: "Plan a dinner",
      description:
        "Adds a dinner on a date, after any dinners already planned that day. Pass dish_id for a known dish (from search_dishes), or dish_name: an existing name is matched case-insensitively, otherwise a new dish is created.",
      inputSchema: {
        date,
        dish_id: z.string().optional(),
        dish_name: z.string().max(200).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    ({ date, dish_id, dish_name }) =>
      run(async () => {
        if (!dish_id === !dish_name) throw new InputError("Pass exactly one of dish_id or dish_name");
        const meal = await addMeal(db, date, dish_id ? { dishId: dish_id } : { name: dish_name! });
        fx.changed();
        return { planned: { date: meal.date, weekday: weekday(meal.date), ...dinner(meal) } };
      }),
  );

  server.registerTool(
    "move_dinner",
    {
      title: "Move a dinner",
      description: "Moves a planned dinner to another date and/or position within the day.",
      inputSchema: {
        meal_id: z.number().int().describe("meal_id from get_week"),
        date,
        position: z.number().int().min(0).optional().describe("0-based position in that day's list; default last"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    ({ meal_id, date, position }) =>
      run(async () => {
        const meal = await moveMeal(db, meal_id, date, position);
        fx.changed();
        return { moved: { date: meal.date, weekday: weekday(meal.date), position: meal.sort_order, ...dinner(meal) } };
      }),
  );

  server.registerTool(
    "remove_dinner",
    {
      title: "Remove a dinner",
      description: "Removes a planned dinner from its day. The dish itself stays in the catalog.",
      inputSchema: { meal_id: z.number().int().describe("meal_id from get_week") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    ({ meal_id }) =>
      run(async () => {
        if (!(await deleteMeal(db, meal_id))) throw new InputError("No dinner with that meal_id", 404);
        fx.changed();
        return { removed: meal_id };
      }),
  );

  server.registerTool(
    "update_dish",
    {
      title: "Update a dish",
      description:
        "Renames a dish or sets its recipe link (absolute http/https URL) and notes. Applies everywhere the dish is planned. Omitted fields stay; an empty string clears recipe_url or notes.",
      inputSchema: {
        dish_id: z.string(),
        name: z.string().max(200).optional(),
        recipe_url: z.string().max(2000).optional(),
        notes: z.string().max(4000).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    ({ dish_id, name, recipe_url, notes }) =>
      run(async () => {
        const dish = await updateDish(db, dish_id, { name, recipe_url, notes });
        fx.changed();
        if (recipe_url !== undefined && dish.recipe_url) fx.refreshPreview(dish.id);
        return { dish };
      }),
  );

  return server;
}

export async function handleMcp(request: Request, db: D1Database, fx: Effects): Promise<Response> {
  const server = buildServer(db, fx);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(request);
}
