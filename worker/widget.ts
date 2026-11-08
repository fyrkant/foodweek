/**
 * Server-rendered, read-only week view meant to be embedded in an iframe,
 * e.g. a Home Assistant Webpage card.
 */

import {
  MONTHS_SV,
  WEEKDAYS_SV,
  addDays,
  formatSpan,
  isoWeekNumber,
  parseDate,
  startOfWeek,
  weekDays,
  type DateStr,
} from "../src/dates";
import { holidayFor } from "../src/holidays";

export type WidgetTheme = "auto" | "light" | "dark";

export interface WidgetMeal {
  date: DateStr;
  name: string;
}

/** Today's date in Sweden, regardless of where the Worker runs. */
export function stockholmToday(): DateStr {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm" }).format(new Date());
}

export function widgetWeek(today: DateStr, offsetWeeks: number): DateStr[] {
  return weekDays(addDays(startOfWeek(parseDate(today)), offsetWeeks * 7));
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const LIGHT = `
  --text: #1b1f24;
  --muted: #6b7280;
  --line: rgba(0, 0, 0, 0.08);
  --today: rgba(31, 111, 235, 0.1);
  --accent: #1f6feb;
  --red: #d92d20;
  --eve: #b45309;`;

const DARK = `
  --text: #e6e8eb;
  --muted: #9aa1ab;
  --line: rgba(255, 255, 255, 0.1);
  --today: rgba(88, 150, 255, 0.16);
  --accent: #6aa4ff;
  --red: #ff7b6e;
  --eve: #f0a75a;`;

function themeCss(theme: WidgetTheme): string {
  if (theme === "light") return `:root {${LIGHT}\n}`;
  if (theme === "dark") return `:root {${DARK}\n}`;
  return `:root {${LIGHT}\n}\n@media (prefers-color-scheme: dark) {\n  :root {${DARK}\n  }\n}`;
}

export function renderWidget(opts: {
  days: DateStr[];
  meals: WidgetMeal[];
  today: DateStr;
  theme: WidgetTheme;
  refreshSeconds: number;
}): string {
  const { days, meals, today, theme, refreshSeconds } = opts;
  const monday = parseDate(days[0]);

  const byDate = new Map<DateStr, string[]>();
  for (const m of meals) {
    const list = byDate.get(m.date) ?? [];
    list.push(m.name);
    byDate.set(m.date, list);
  }

  const rows = days
    .map((date) => {
      const d = parseDate(date);
      const weekday = WEEKDAYS_SV[(d.getUTCDay() + 6) % 7].slice(0, 3);
      const holiday = holidayFor(date);
      const names = byDate.get(date) ?? [];
      const classes = ["day"];
      if (date === today) classes.push("today");
      if (date < today) classes.push("past");
      if (holiday?.red) classes.push("red");

      const dinners = names.length
        ? names.map((n) => `<div class="dinner">${esc(n)}</div>`).join("")
        : `<div class="dinner empty">–</div>`;
      const holidayHtml = holiday
        ? `<div class="holiday ${holiday.red ? "is-red" : "is-eve"}">${esc(holiday.name)}</div>`
        : "";

      return `<li class="${classes.join(" ")}">
  <div class="when"><span class="wd">${weekday}</span><span class="num">${d.getUTCDate()}</span></div>
  <div class="what">${holidayHtml}${dinners}</div>
</li>`;
    })
    .join("\n");

  const todayDate = parseDate(today);
  const title = `Vecka ${isoWeekNumber(monday)}`;
  const label = `Middagar ${title.toLowerCase()}, ${todayDate.getUTCDate()} ${MONTHS_SV[todayDate.getUTCMonth()]}`;

  return `<!doctype html>
<html lang="sv">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="${refreshSeconds}">
<title>${esc(label)}</title>
<style>
${themeCss(theme)}
* { box-sizing: border-box; }
html, body {
  margin: 0;
  background: transparent;
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
}
body { padding: 12px 14px; }
header { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
h1 { margin: 0; font-size: 1.05rem; font-weight: 650; }
.span { color: var(--muted); font-size: 0.85rem; white-space: nowrap; }
ul { list-style: none; margin: 0; padding: 0; }
.day {
  display: grid;
  grid-template-columns: 3.2rem 1fr;
  gap: 10px;
  align-items: start;
  padding: 7px 8px;
  border-top: 1px solid var(--line);
  border-radius: 8px;
}
.day:first-child { border-top-color: transparent; }
.day.today { background: var(--today); border-top-color: transparent; }
.day.today + .day { border-top-color: transparent; }
.day.past { opacity: 0.5; }
.when { display: flex; align-items: baseline; gap: 5px; }
.wd { font-size: 0.8rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.03em; width: 1.9rem; }
.num { font-weight: 650; font-variant-numeric: tabular-nums; }
.today .wd, .today .num { color: var(--accent); }
.red .wd, .red .num { color: var(--red); }
.dinner { line-height: 1.35; overflow-wrap: anywhere; }
.dinner + .dinner { margin-top: 2px; }
.dinner.empty { color: var(--muted); }
.holiday { font-size: 0.75rem; font-weight: 600; margin-bottom: 1px; }
.holiday.is-red { color: var(--red); }
.holiday.is-eve { color: var(--eve); }
</style>
</head>
<body>
<header><h1>${title}</h1><span class="span">${esc(formatSpan(monday))}</span></header>
<ul>
${rows}
</ul>
</body>
</html>
`;
}
