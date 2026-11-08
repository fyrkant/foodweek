/**
 * Minimal iCalendar (RFC 5545) writer for the meal feed.
 * Each meal becomes an all-day event on its date.
 */

export interface FeedMeal {
  id: number;
  date: string; // YYYY-MM-DD
  name: string;
  recipe_url: string | null;
  notes: string | null;
}

function escapeText(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/** Fold lines longer than 75 octets, never splitting a UTF-8 sequence. */
function fold(line: string): string {
  const encoder = new TextEncoder();
  const parts: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const ch of line) {
    const len = encoder.encode(ch).length;
    const limit = parts.length === 0 ? 75 : 74; // continuation lines start with a space
    if (currentBytes + len > limit) {
      parts.push(current);
      current = "";
      currentBytes = 0;
    }
    current += ch;
    currentBytes += len;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

function compactDate(date: string): string {
  return date.replace(/-/g, "");
}

function nextDay(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return next.toISOString().slice(0, 10);
}

export function buildCalendar(meals: FeedMeal[], host: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//foodweek//Veckans middagar//SV",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Middagar",
    "X-WR-TIMEZONE:Europe/Stockholm",
  ];
  for (const meal of meals) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:meal-${meal.id}@${host}`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${compactDate(meal.date)}`,
      `DTEND;VALUE=DATE:${compactDate(nextDay(meal.date))}`,
      `SUMMARY:${escapeText(meal.name)}`,
      "TRANSP:TRANSPARENT",
    );
    if (meal.recipe_url) lines.push(`URL:${meal.recipe_url}`);
    const description = [meal.notes, meal.recipe_url].filter(Boolean).join("\n\n");
    if (description) lines.push(`DESCRIPTION:${escapeText(description)}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}
