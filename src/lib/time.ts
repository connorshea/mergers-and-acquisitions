// Time values coarser than a year: Wikibase precision 8 (decade), 7 (century),
// 6 (millennium) and below. Wikidata stores "20th century" as `+1901-00-00`
// (or `+2000-00-00`) with `precision: 7`, so the year alone reads as 1901;
// the `timePrecision` field on a time Value (see wikibase.ts snakValue) says
// how much of it to believe. Display text and the span of years such a value
// covers live here. DOM-free like compare.ts, which uses it.

import type { Value } from "./compare.ts";

/** Wikibase's year precision; anything below it is a decade, century, … */
export const YEAR_PRECISION = 9;

const yearOf = (time: string): number | null => {
  const m = /^([+-]?\d+)-/.exec(time);
  return m ? Number(m[1]) : null;
};

/** Whether a time value is only known to the decade, century or coarser. */
export const isCoarseTime = (v: Value): boolean =>
  v.type === "time" && v.timePrecision !== undefined && v.timePrecision < YEAR_PRECISION;

const ordinal = (n: number): string => {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : (["st", "nd", "rd"][(n % 10) - 1] ?? "th");
  return `${n}${suffix}`;
};

/**
 * The 1-based ordinal (century, millennium) a year falls in, the way Wikibase
 * displays it: 1901 and 2000 are both the 20th century. `unit` is 100 or 1000.
 */
const nthUnit = (year: number, unit: number): number =>
  Math.max(1, Math.ceil(Math.abs(year) / unit));

/**
 * The inclusive range of years a coarse time value covers: the 20th century is
 * 1901–2000, the 1990s 1990–1999, the 5th century BCE −500…−401. Null for a
 * value at year precision or finer (its year is exact) or one that won't parse.
 */
export function coarseTimeRange(v: Value): [number, number] | null {
  if (!isCoarseTime(v)) return null;
  const year = yearOf(v.value);
  if (year === null) return null;
  const p = v.timePrecision!;
  const sign = year < 0 ? -1 : 1;
  const span = (lo: number, hi: number): [number, number] => (sign > 0 ? [lo, hi] : [-hi, -lo]);
  if (p === 8) {
    const d = Math.floor(Math.abs(year) / 10) * 10;
    return span(d, d + 9);
  }
  if (p === 7 || p === 6) {
    const unit = p === 7 ? 100 : 1000;
    const n = nthUnit(year, unit);
    return span((n - 1) * unit + 1, n * unit);
  }
  // 10,000 years and coarser: the year rounded to that many years.
  const unit = 10 ** (YEAR_PRECISION - p);
  const mid = Math.round(year / unit) * unit;
  return [mid - unit / 2, mid + unit / 2];
}

/**
 * Display text for a coarse time value — "1990s", "20th century", "5th century
 * BCE", "2nd millennium" — or null for one at year precision or finer.
 */
export function coarseTimeText(v: Value): string | null {
  if (!isCoarseTime(v)) return null;
  const year = yearOf(v.value);
  if (year === null) return null;
  const p = v.timePrecision!;
  const era = year < 0 ? " BCE" : "";
  if (p === 8) return `${Math.floor(Math.abs(year) / 10) * 10}s${era}`;
  if (p === 7) return `${ordinal(nthUnit(year, 100))} century${era}`;
  if (p === 6) return `${ordinal(nthUnit(year, 1000))} millennium${era}`;
  const unit = 10 ** (YEAR_PRECISION - p);
  const rounded = Math.round(Math.abs(year) / unit) * unit;
  return `around ${rounded.toLocaleString("en")}${era} (to ${unit.toLocaleString("en")} years)`;
}
