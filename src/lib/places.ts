// Place containment: whether one place value lies inside another along
// "located in the administrative territorial entity" (P131+), so a
// headquarters given as Akasaka on one item and Tokyo on the other reads as
// the same place at two levels of detail rather than a disagreement. DOM-free,
// shared by the hunt, the candidate detail API, and the comparison view.

import type { Item } from "./compare.ts";

/**
 * Item properties whose values are places, compared by containment as well as
 * by QID (see compareValues). The weekly place-ancestor sync looks up the
 * values of exactly these.
 */
export const PLACE_PROPS: ReadonlySet<string> = new Set<string>([
  "P159", // headquarters location
  "P19", // place of birth
  "P20", // place of death
  "P131", // located in the administrative territorial entity
  "P276", // location
  "P740", // location of formation
  "P291", // place of publication
]);

/**
 * Classes whose instances count as a country when they contain the other
 * value: country, sovereign state, historical country, and the countries of
 * the United Kingdom. A city and its country agree, but so do most of a
 * country's namesakes, so that containment isn't evidence (see PlaceLevel).
 */
export const COUNTRY_CLASSES: readonly string[] = ["Q6256", "Q3624078", "Q3024240", "Q3336843"];

/**
 * How a place is contained in another: `local` when the containing place is
 * below country level (Akasaka in Tokyo), `country` when it is a country
 * (Tokyo in Japan). The comparison counts a `local` containment as similar
 * and a `country` one as neither agreement nor disagreement.
 */
export type PlaceLevel = "local" | "country";

/**
 * How `place` lies in `container`, or null when it doesn't (or its ancestors
 * weren't looked up). Built by makePlaceContainment.
 */
export type PlaceContainment = (place: string, container: string) => PlaceLevel | null;

/**
 * The containment check over each place's P131+ ancestors (the
 * `place_ancestors` table) and the set of those ancestors that are countries.
 * A place with no entry has no known ancestors, so it contains and is
 * contained in nothing, as before the sync.
 */
export function makePlaceContainment(
  ancestors: ReadonlyMap<string, readonly string[]>,
  countries: ReadonlySet<string>,
): PlaceContainment {
  return (place, container) => {
    if (!ancestors.get(place)?.includes(container)) return null;
    return countries.has(container) ? "country" : "local";
  };
}

/**
 * Every distinct place value (PLACE_PROPS) on the given items. An item whose
 * data lacks statements is skipped: the hunt reads a whole window with this,
 * and one malformed item must fail only its own pairs.
 */
export function placeValues(items: Iterable<Partial<Pick<Item, "statements">>>): string[] {
  const out = new Set<string>();
  for (const item of items) {
    for (const pid of PLACE_PROPS) {
      for (const v of item.statements?.[pid] ?? []) if (v.type === "item") out.add(v.value);
    }
  }
  return [...out];
}

/** One `place_ancestors` row. */
export interface PlaceAncestorRow {
  qid: string;
  ancestor: string;
  country: boolean;
}

/** The containment check over `place_ancestors` rows; null when there are none. */
export function placeContainmentFromRows(
  rows: Iterable<PlaceAncestorRow>,
): PlaceContainment | null {
  const ancestors = new Map<string, string[]>();
  const countries = new Set<string>();
  for (const { qid, ancestor, country } of rows) {
    const list = ancestors.get(qid);
    if (list) list.push(ancestor);
    else ancestors.set(qid, [ancestor]);
    if (country) countries.add(ancestor);
  }
  return ancestors.size === 0 ? null : makePlaceContainment(ancestors, countries);
}
