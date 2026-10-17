// Derived `items` / `external_ids` / `item_values` columns (primary type,
// display label, external-id and item-value rows) from the simplified `Item` model. DOM-free so the server,
// jobs, scripts, and the SPA can all import it.

import type { Item } from "./compare.ts";
import { PLACE_PROPS } from "./places.ts";

// ---------- derived rows for the DB ----------

/** First `P31` (instance of) item value, e.g. "Q7889" — the denormalized primary type. */
export function primaryType(item: Item): string | undefined {
  return item.statements.P31?.find((v) => v.type === "item")?.value;
}

/**
 * Best display label with the language it came from: English, then `mul`, then
 * any other language (the first one the item carries).
 */
export function displayLabel(item: Item): { text: string; lang: string } | undefined {
  for (const lang of ["en", "mul"]) {
    const text = item.labels[lang];
    if (text) return { text, lang };
  }
  const [lang, text] = Object.entries(item.labels).find(([, t]) => t) ?? [];
  return lang && text ? { text, lang } : undefined;
}

/** Longest label the `primary_label` / `from_label` / `into_label` columns hold (varchar, in characters). */
export const MAX_LABEL_CHARS = 255;

/**
 * Best display label: English, then `mul`, then any other language. Cut to
 * MAX_LABEL_CHARS code points (ending in "…") so it fits the columns it is
 * stored in: a few items carry longer labels, e.g. a 260-character Italian
 * book title with no English one.
 */
export function primaryLabel(item: Item): string | undefined {
  const text = displayLabel(item)?.text;
  // UTF-16 length is never under the code-point count MariaDB measures.
  if (text === undefined || text.length <= MAX_LABEL_CHARS) return text;
  // Code points, deliberately: the column's limit counts them, not graphemes.
  const chars = Array.from(text);
  return chars.length <= MAX_LABEL_CHARS
    ? text
    : `${chars.slice(0, MAX_LABEL_CHARS - 1).join("")}…`;
}

/**
 * Properties whose item values go to the `item_values` table, for the weekly
 * syncs to collect without reading every item's data: instance of and
 * subclass of (class ancestors) and the place properties (place ancestors).
 */
export const ITEM_VALUE_PROPS: ReadonlySet<string> = new Set(["P31", "P279", ...PLACE_PROPS]);

/** Distinct item-valued `(property, value)` rows of ITEM_VALUE_PROPS for the `item_values` table. */
export function itemValueRows(item: Item): { property: string; value: string }[] {
  const rows: { property: string; value: string }[] = [];
  const seen = new Set<string>();
  for (const [property, values] of Object.entries(item.statements)) {
    if (!ITEM_VALUE_PROPS.has(property)) continue;
    for (const v of values) {
      if (v.type !== "item") continue;
      const key = `${property} ${v.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ property, value: v.value });
    }
  }
  return rows;
}

/** External-id `(property, value)` rows for the `external_ids` blocking table. */
export function externalIdRows(item: Item): { property: string; value: string }[] {
  const rows: { property: string; value: string }[] = [];
  for (const [property, values] of Object.entries(item.statements)) {
    for (const v of values) {
      if (v.type === "external-id") rows.push({ property, value: v.value });
    }
  }
  return rows;
}
