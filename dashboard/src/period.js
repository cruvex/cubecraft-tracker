// Helpers for the selected period: "7" or "30" days, a "YYYY-MM" month, or a "YYYY" year.
import { state } from "./state.js";

const MONTH_PATTERN = /^\d{4}-\d{2}$/;
const YEAR_PATTERN = /^\d{4}$/;

// Formatted in UTC to match the server's month buckets.
const longMonth = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
const shortMonth = new Intl.DateTimeFormat(undefined, { month: "short", timeZone: "UTC" });

/** The current year in UTC, to match the server's buckets, e.g. "2026". */
export function currentYear() {
  return String(new Date().getUTCFullYear());
}

/** The selected period as `{ days }`, `{ month }` or `{ year }`. */
export function selectedPeriod() {
  const period = state.topGainersPeriod;
  if (MONTH_PATTERN.test(period)) return { month: period };
  if (YEAR_PATTERN.test(period)) return { year: period };
  return { days: Number(period) };
}

/** "7D", the month's name, e.g. "August 2026", or the year, e.g. "2026". */
export function periodLabel() {
  const { days, month, year } = selectedPeriod();
  if (year) return year;
  return month ? formatMonth(month) : `${days}D`;
}

export function monthStart(month) {
  return new Date(`${month}-01T00:00:00Z`);
}

/** "August 2026". */
export function formatMonth(month) {
  return longMonth.format(monthStart(month));
}

/** "Aug". */
export function formatShortMonth(month) {
  return shortMonth.format(monthStart(month));
}
