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

/** Parses a 6-digit hex colour ("FF9F0A" or "#FF9F0A"); anything else is ignored. */
export function parseAccent(value: string | undefined): string | undefined {
  const hex = value?.replace(/^#/, "");
  return hex && /^[0-9a-fA-F]{6}$/.test(hex) ? hex.toLowerCase() : undefined;
}

function accentCss(hex: string): string {
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `:root {\n  --accent: #${hex};\n  --today: rgba(${r}, ${g}, ${b}, 0.18);\n}`;
}

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
  accent?: string;
  /** Weeks from the current one; 0 is this week. */
  offset: number;
  refreshSeconds: number;
  /** When showing another week, jump back to the current one after this long. */
  returnSeconds: number;
}): string {
  const { days, meals, today, theme, accent, offset, refreshSeconds, returnSeconds } = opts;
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

  const href = (week: number) => {
    const params = new URLSearchParams();
    if (theme !== "auto") params.set("theme", theme);
    if (accent) params.set("accent", accent);
    if (week !== 0) params.set("week", String(week));
    const qs = params.toString();
    return esc(qs ? `/widget?${qs}` : "/widget");
  };
  const refresh =
    offset === 0 ? String(refreshSeconds) : `${returnSeconds}; url=${href(0)}`;

  const todayDate = parseDate(today);
  const title = `Vecka ${isoWeekNumber(monday)}`;
  const label = `Middagar ${title.toLowerCase()}, ${todayDate.getUTCDate()} ${MONTHS_SV[todayDate.getUTCMonth()]}`;

  return `<!doctype html>
<html lang="sv">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="${refresh}">
<title>${esc(label)}</title>
<style>
${themeCss(theme)}
${accent ? accentCss(accent) : ""}
* { box-sizing: border-box; }
html, body {
  margin: 0;
  background: transparent;
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
}
body { padding: 12px 14px; }
header { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
h1 { margin: 0; font-size: 1.05rem; font-weight: 650; line-height: 1.2; }
.span { display: block; color: var(--muted); font-size: 0.8rem; white-space: nowrap; }
nav { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
nav a {
  display: inline-grid;
  place-items: center;
  min-width: 34px;
  height: 34px;
  padding: 0 10px;
  border-radius: 17px;
  background: var(--line);
  color: var(--text);
  text-decoration: none;
  font-size: 0.85rem;
  font-weight: 600;
  -webkit-tap-highlight-color: transparent;
}
nav a:active { opacity: 0.6; }
nav a.arrow { padding: 0; font-size: 1.2rem; line-height: 1; }
nav a.now { color: var(--accent); }
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
<header>
  <div><h1>${title}</h1><span class="span">${esc(formatSpan(monday))}</span></div>
  <nav>
    ${offset !== 0 ? `<a class="now" href="${href(0)}">Idag</a>` : ""}
    <a class="arrow" href="${href(offset - 1)}" aria-label="Föregående vecka">‹</a>
    <a class="arrow" href="${href(offset + 1)}" aria-label="Nästa vecka">›</a>
  </nav>
</header>
<ul>
${rows}
</ul>
</body>
</html>
`;
}
