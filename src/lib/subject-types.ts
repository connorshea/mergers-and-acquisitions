// Subject type constraints (P2302 = Q21503250) on Wikidata properties, and the
// check the scorer uses to ignore an external id on an item it can't apply to:
// a BVMC *person* ID (P2799) copied onto a literary work, say, which then
// "matches" on every work by the same author. DOM-free, shared by the hunt,
// the property sync, and the offline eval.

import type { Item } from "./compare.ts";

/** "subject type constraint" — the P2302 value this module reads. */
export const SUBJECT_TYPE_CONSTRAINT = "Q21503250";

/** P2309 ("relation") values, and what each makes the constraint check. */
export const RELATION_QIDS: Record<string, SubjectTypeRelation> = {
  Q21503252: "instance", // instance of
  Q21514624: "subclass", // subclass of
  Q30208840: "either", // instance or subclass of
};

/**
 * How the item must relate to one of the classes: `instance` checks its
 * instance of (P31) values, `subclass` its subclass of (P279) values, `either`
 * both. A constraint without a relation qualifier is read as `either`, the
 * lenient choice.
 */
export type SubjectTypeRelation = "instance" | "subclass" | "either";

/** One subject type constraint statement on a property. */
export interface SubjectTypeConstraint {
  /** The allowed classes (P2308). */
  classes: string[];
  relation: SubjectTypeRelation;
  /** Items the constraint exempts (P2303). */
  exceptions: string[];
}

/**
 * Each class's ancestors along subclass of (P279*), itself included, limited
 * to classes some subject type constraint names (the `class_ancestors` table).
 * A class with no entry hasn't been looked up, so it's treated as unknown.
 */
export type ClassAncestors = ReadonlyMap<string, readonly string[]>;

const itemValues = (item: Item, pid: string): string[] =>
  (item.statements[pid] ?? []).filter((v) => v.type === "item").map((v) => v.value);

/**
 * Whether the item satisfies one constraint, or `null` when that can't be
 * told: the item has no instance of / subclass of at all, or one of the
 * classes it would be judged by has no ancestor data.
 */
function satisfies(
  item: Item,
  constraint: SubjectTypeConstraint,
  ancestors: ClassAncestors,
): boolean | null {
  if (constraint.exceptions.includes(item.id)) return true;
  const p31 = itemValues(item, "P31");
  const p279 = itemValues(item, "P279");
  if (p31.length === 0 && p279.length === 0) return null;
  const allowed = new Set(constraint.classes);
  // A subclass of an allowed class may be that class itself (P279* is reflexive).
  if (constraint.relation !== "instance" && allowed.has(item.id)) return true;
  const classes =
    constraint.relation === "instance"
      ? p31
      : constraint.relation === "subclass"
        ? p279
        : [...p31, ...p279];
  let unknown = false;
  for (const cls of classes) {
    const up = ancestors.get(cls);
    if (!up) unknown = true;
    else if (up.some((a) => allowed.has(a))) return true;
  }
  return unknown ? null : false;
}

/**
 * Build the scorer's `isInapplicableId` predicate: true when every subject
 * type constraint on the property rules the item out. It fails open, so that
 * an incomplete sync never hides real evidence: a property with no constraint,
 * an item listed as an exception, and an item whose classes have no ancestor
 * data yet all count as applicable.
 */
export function makeInapplicableIdCheck(
  constraints: ReadonlyMap<string, readonly SubjectTypeConstraint[]>,
  ancestors: ClassAncestors,
): (pid: string, item: Item) => boolean {
  return (pid, item) => {
    const list = constraints.get(pid);
    if (!list || list.length === 0) return false;
    return list.every((c) => satisfies(item, c, ancestors) === false);
  };
}

/** The item's instance of and subclass of values: the classes to look up ancestors for. */
export function itemClasses(item: Item): string[] {
  return [...new Set([...itemValues(item, "P31"), ...itemValues(item, "P279")])];
}
