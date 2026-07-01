/**
 * Date helpers. A "day" is always represented as a `YYYY-MM-DD` string.
 * Internally we use UTC to avoid timezone/DST drift.
 */

export type DateStr = string; // YYYY-MM-DD

export const WEEKDAYS_SV = [
  "Måndag",
  "Tisdag",
  "Onsdag",
  "Torsdag",
  "Fredag",
  "Lördag",
  "Söndag",
];

export const MONTHS_SV = [
  "januari",
  "februari",
  "mars",
  "april",
  "maj",
  "juni",
  "juli",
  "augusti",
  "september",
  "oktober",
  "november",
  "december",
];

export function toDateStr(d: Date): DateStr {
  return d.toISOString().slice(0, 10);
}

export function parseDate(s: DateStr): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function addDays(d: Date, days: number): Date {
  const r = new Date(d);
  r.setUTCDate(r.getUTCDate() + days);
  return r;
}

/** Monday of the week that contains `d`. */
export function startOfWeek(d: Date): Date {
  const r = new Date(d);
  const day = r.getUTCDay(); // 0=Sun..6=Sat
  const diff = (day + 6) % 7; // days since Monday
  r.setUTCDate(r.getUTCDate() - diff);
  r.setUTCHours(0, 0, 0, 0);
  return r;
}

/** The 7 date strings (Mon..Sun) of the week starting at `monday`. */
export function weekDays(monday: Date): DateStr[] {
  return Array.from({ length: 7 }, (_, i) => toDateStr(addDays(monday, i)));
}

/** ISO-8601 week number (used in Sweden). */
export function isoWeekNumber(d: Date): number {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (date.getUTCDay() + 6) % 7; // Mon=0
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // nearest Thursday
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const diff = date.getTime() - firstThursday.getTime();
  return 1 + Math.round(diff / (7 * 24 * 3600 * 1000));
}

/** "16–22 juni 2026" or spanning months/years as needed. */
export function formatSpan(monday: Date): string {
  const sunday = addDays(monday, 6);
  const d1 = monday.getUTCDate();
  const d2 = sunday.getUTCDate();
  const m1 = MONTHS_SV[monday.getUTCMonth()];
  const m2 = MONTHS_SV[sunday.getUTCMonth()];
  const y1 = monday.getUTCFullYear();
  const y2 = sunday.getUTCFullYear();
  if (y1 !== y2) return `${d1} ${m1} ${y1} – ${d2} ${m2} ${y2}`;
  if (m1 !== m2) return `${d1} ${m1} – ${d2} ${m2} ${y1}`;
  return `${d1}–${d2} ${m1} ${y1}`;
}

export function isToday(s: DateStr, today: DateStr): boolean {
  return s === today;
}
