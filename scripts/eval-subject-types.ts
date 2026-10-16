// Subject type constraints and class ancestors for the eval pairs, kept in
// `eval-data/subject-types.json`, along with which of their shared id
// properties mirror Wikidata, and the P131+ ancestors of their place values.
// Production reads these from the synced `properties.subject_types`,
// `class_ancestors`, `properties.mirrors_wikidata` and `place_ancestors`;
// recording the slice the eval pairs need lets the offline scorer apply the
// same checks (ScoreOptions.isInapplicableId / isMirroredIdProp /
// placeContainment) without a DB.
//
// Like the sitelink redirects, it's append-only: recorded entries are never
// overwritten or dropped, so a later edit to a constraint or to the class tree
// doesn't silently change what the eval scores. A re-run only adds what's
// missing; delete the file to start over. Written by
// scripts/resolve-eval-subject-types.ts.

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Item } from "../src/lib/compare.ts";
import { makePlaceContainment, type PlaceContainment, placeValues } from "../src/lib/places.ts";
import {
  fetchClassAncestors,
  fetchMirroredProps,
  fetchPlaceAncestors,
  fetchSubjectTypes,
} from "../src/lib/sparql.ts";
import {
  itemClasses,
  makeInapplicableIdCheck,
  type SubjectTypeConstraint,
} from "../src/lib/subject-types.ts";

export const SUBJECT_TYPES_PATH = join("eval-data", "subject-types.json");

interface SubjectTypesFile {
  /** When an entry was last added (existing entries keep their values). */
  checkedAt: string;
  /** The subject type constraints of every external id both items of some pair carry. */
  constraints: Record<string, SubjectTypeConstraint[]>;
  /** Each eval item class's ancestors, as `class_ancestors` holds them. */
  ancestors: Record<string, string[]>;
  /**
   * Whether each external id both items of some pair carry mirrors Wikidata
   * (P31 = Q24075706), as `properties.mirrors_wikidata` holds it.
   */
  mirrors?: Record<string, boolean>;
  /**
   * Each eval item's place value's P131+ ancestors, as `place_ancestors`
   * holds them (empty when it has none, so it isn't looked up again).
   */
  places?: Record<string, string[]>;
  /** Which of those ancestors are countries (`place_ancestors.country`). */
  countries?: string[];
}

async function readFileOrNull(): Promise<SubjectTypesFile | null> {
  try {
    return JSON.parse(await readFile(SUBJECT_TYPES_PATH, "utf8")) as SubjectTypesFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** External-id properties both items carry: the only ones the checks are asked about. */
function sharedIdProps(a: Item, b: Item): string[] {
  const isId = (item: Item, pid: string) =>
    (item.statements[pid] ?? []).some((v) => v.type === "external-id");
  return Object.keys(a.statements).filter((pid) => isId(a, pid) && isId(b, pid));
}

/**
 * Look up what the pairs need and isn't recorded yet, and add it to the file.
 * Constraints and the mirror flags are fetched wholesale (one query each)
 * and kept for the pairs' shared id properties; ancestors only for classes
 * not recorded yet. Returns how many properties and classes were added.
 * Throws when QLever can't be read; the file is left as it was.
 */
export async function recordSubjectTypes(
  pairs: [Item, Item][],
): Promise<{ constraints: number; classes: number; mirrors: number; places: number }> {
  const file: SubjectTypesFile = (await readFileOrNull()) ?? {
    checkedAt: "",
    constraints: {},
    ancestors: {},
  };
  const mirrors = file.mirrors ?? {};
  const places = file.places ?? {};
  const countries = new Set(file.countries);
  const pids = new Set(pairs.flatMap(([a, b]) => sharedIdProps(a, b)));
  const classes = new Set(pairs.flat().flatMap(itemClasses));
  const all = await fetchSubjectTypes();
  let addedConstraints = 0;
  for (const pid of [...pids].sort()) {
    const list = all.get(pid);
    if (!list || pid in file.constraints) continue;
    file.constraints[pid] = list;
    addedConstraints++;
  }
  const missing = [...classes].filter((c) => !(c in file.ancestors));
  const { ancestors, failed } = await fetchClassAncestors(missing);
  if (failed.length > 0) throw new Error(`ancestor lookup failed for ${failed.length} classes`);
  for (const [cls, list] of ancestors) file.ancestors[cls] = list;
  const unflagged = [...pids].filter((pid) => !(pid in mirrors));
  if (unflagged.length > 0) {
    const mirrored = await fetchMirroredProps();
    for (const pid of unflagged) mirrors[pid] = mirrored.has(pid);
  }
  const unplaced = placeValues(pairs.flat()).filter((q) => !(q in places));
  if (unplaced.length > 0) {
    const found = await fetchPlaceAncestors(unplaced);
    if (found.failed.length > 0)
      throw new Error(`place ancestor lookup failed for ${found.failed.length} places`);
    for (const q of unplaced) {
      const list = found.ancestors.get(q) ?? [];
      places[q] = list.map((e) => e.ancestor).sort();
      for (const e of list) if (e.country) countries.add(e.ancestor);
    }
  }
  if (addedConstraints > 0 || ancestors.size > 0 || unflagged.length > 0 || unplaced.length > 0) {
    file.checkedAt = new Date().toISOString().slice(0, 10);
    const sorted = (o: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(o).sort(([x], [y]) => x.localeCompare(y)));
    const out = {
      checkedAt: file.checkedAt,
      constraints: sorted(file.constraints),
      ancestors: sorted(file.ancestors),
      mirrors: sorted(mirrors),
      places: sorted(places),
      countries: [...countries].sort(),
    };
    await writeFile(SUBJECT_TYPES_PATH, JSON.stringify(out, null, 2) + "\n");
  }
  return {
    constraints: addedConstraints,
    classes: ancestors.size,
    mirrors: unflagged.length,
    places: unplaced.length,
  };
}

/** The recorded constraint check, or undefined when nothing is recorded. */
export async function loadInapplicableIdCheck(): Promise<
  ((pid: string, item: Item) => boolean) | undefined
> {
  const file = await readFileOrNull();
  if (!file) return undefined;
  return makeInapplicableIdCheck(
    new Map(Object.entries(file.constraints)),
    new Map(Object.entries(file.ancestors)),
  );
}

/** The recorded mirror flags as a predicate, or undefined when none are recorded. */
export async function loadMirroredIdCheck(): Promise<((pid: string) => boolean) | undefined> {
  const mirrors = (await readFileOrNull())?.mirrors;
  if (!mirrors) return undefined;
  return (pid) => mirrors[pid] === true;
}

/** The recorded place containment, or undefined when none is recorded. */
export async function loadPlaceContainment(): Promise<PlaceContainment | undefined> {
  const file = await readFileOrNull();
  if (!file?.places) return undefined;
  return makePlaceContainment(new Map(Object.entries(file.places)), new Set(file.countries));
}
