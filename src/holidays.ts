/**
 * Swedish holidays ("röda dagar") plus the major eves people care about
 * when planning dinners (julafton, midsommarafton, nyårsafton, ...).
 *
 * Movable feasts are derived from Easter Sunday, computed with the
 * Anonymous Gregorian algorithm.
 */

import { toDateStr, type DateStr } from "./dates";

export interface Holiday {
  name: string;
  /** Official public holiday ("röd dag") vs. a notable eve. */
  red: boolean;
}

function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); // 3=Mar, 4=Apr
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

function addDays(d: Date, days: number): Date {
  const r = new Date(d);
  r.setUTCDate(r.getUTCDate() + days);
  return r;
}

/** First weekday `target` (0=Sun..6=Sat) within [from..to] inclusive. */
function weekdayBetween(year: number, fromMonth: number, fromDay: number, target: number): Date {
  let d = new Date(Date.UTC(year, fromMonth, fromDay));
  while (d.getUTCDay() !== target) d = addDays(d, 1);
  return d;
}

const cache = new Map<number, Map<DateStr, Holiday>>();

function buildYear(year: number): Map<DateStr, Holiday> {
  const map = new Map<DateStr, Holiday>();
  const add = (d: Date, name: string, red: boolean) => map.set(toDateStr(d), { name, red });

  const fixed = (month: number, day: number) => new Date(Date.UTC(year, month, day));
  const easter = easterSunday(year);

  // Fixed red days
  add(fixed(0, 1), "Nyårsdagen", true);
  add(fixed(0, 6), "Trettondedag jul", true);
  add(fixed(4, 1), "Första maj", true);
  add(fixed(5, 6), "Sveriges nationaldag", true);
  add(fixed(11, 25), "Juldagen", true);
  add(fixed(11, 26), "Annandag jul", true);

  // Easter-based red days
  add(addDays(easter, -2), "Långfredagen", true);
  add(addDays(easter, 0), "Påskdagen", true);
  add(addDays(easter, 1), "Annandag påsk", true);
  add(addDays(easter, 39), "Kristi himmelsfärds dag", true);
  add(addDays(easter, 49), "Pingstdagen", true);

  // Saturdays with fixed windows
  add(weekdayBetween(year, 5, 20, 6), "Midsommardagen", true); // Sat 20–26 Jun
  add(weekdayBetween(year, 9, 31, 6), "Alla helgons dag", true); // Sat 31 Oct – 6 Nov

  // Notable eves (not official red days, but relevant for dinners)
  add(fixed(11, 24), "Julafton", false);
  add(fixed(11, 31), "Nyårsafton", false);
  add(addDays(easter, -3), "Skärtorsdagen", false);
  add(addDays(easter, -1), "Påskafton", false);
  add(addDays(weekdayBetween(year, 5, 20, 6), -1), "Midsommarafton", false);
  add(addDays(weekdayBetween(year, 9, 31, 6), -1), "Allhelgonaafton", false);
  add(fixed(3, 30), "Valborgsmässoafton", false);

  return map;
}

export function holidayFor(dateStr: DateStr): Holiday | undefined {
  const year = Number(dateStr.slice(0, 4));
  let yearMap = cache.get(year);
  if (!yearMap) {
    yearMap = buildYear(year);
    cache.set(year, yearMap);
  }
  return yearMap.get(dateStr);
}
