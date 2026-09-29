// Subject type constraints and class ancestors for the eval pairs, kept in
// `eval-data/subject-types.json`. Production reads them from the synced
// `properties.subject_types` and `class_ancestors`; recording the slice the
// eval pairs need lets the offline scorer apply the same constraint check
// (ScoreOptions.isInapplicableId) without a DB.
//
// Like the sitelink redirects, it's append-only: recorded entries are never
// overwritten or dropped, so a later edit to a constraint or to the class tree
// doesn't silently change what the eval scores. A re-run only adds what's
// missing; delete the file to start over. Written by
// scripts/resolve-eval-subject-types.ts.

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Item } from "../src/lib/compare.ts";
import { fetchClassAncestors, fetchSubjectTypes } from "../src/lib/sparql.ts";
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
}

async function readFileOrNull(): Promise<SubjectTypesFile | null> {
  try {
    return JSON.parse(await readFile(SUBJECT_TYPES_PATH, "utf8")) as SubjectTypesFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** External-id properties both items carry: the only ones the check is asked about. */
function sharedIdProps(a: Item, b: Item): string[] {
  const isId = (item: Item, pid: string) =>
    (item.statements[pid] ?? []).some((v) => v.type === "external-id");
  return Object.keys(a.statements).filter((pid) => isId(a, pid) && isId(b, pid));
}

/**
 * Look up what the pairs need and isn't recorded yet, and add it to the file.
 * Constraints are fetched wholesale (one query) and kept for the pairs'
 * shared id properties; ancestors only for classes not recorded yet. Returns
 * how many properties and classes were added. Throws when QLever can't be
 * read; the file is left as it was.
 */
export async function recordSubjectTypes(
  pairs: [Item, Item][],
): Promise<{ constraints: number; classes: number }> {
  const file: SubjectTypesFile = (await readFileOrNull()) ?? {
    checkedAt: "",
    constraints: {},
    ancestors: {},
  };
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
  if (addedConstraints > 0 || ancestors.size > 0) {
    file.checkedAt = new Date().toISOString().slice(0, 10);
    const sorted = (o: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(o).sort(([x], [y]) => x.localeCompare(y)));
    const out = {
      checkedAt: file.checkedAt,
      constraints: sorted(file.constraints),
      ancestors: sorted(file.ancestors),
    };
    await writeFile(SUBJECT_TYPES_PATH, JSON.stringify(out, null, 2) + "\n");
  }
  return { constraints: addedConstraints, classes: ancestors.size };
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
