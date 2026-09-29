import { describe, expect, it } from "vite-plus/test";
import type { Item } from "./compare.ts";
import {
  itemClasses,
  makeInapplicableIdCheck,
  type SubjectTypeConstraint,
} from "./subject-types.ts";

function item(id: string, p31: string[], p279: string[] = []): Item {
  const refs = (qids: string[]) => qids.map((value) => ({ type: "item" as const, value }));
  const statements: Item["statements"] = {};
  if (p31.length > 0) statements.P31 = refs(p31);
  if (p279.length > 0) statements.P279 = refs(p279);
  return { id, labels: {}, descriptions: {}, aliases: {}, sitelinks: {}, statements };
}

const person: SubjectTypeConstraint = {
  classes: ["Q5", "Q16334295"],
  relation: "instance",
  exceptions: [],
};
// literary work → written work → work; human → itself only (among constraint classes).
const ancestors = new Map([
  ["Q7725634", ["Q7725634", "Q47461344", "Q386724"]],
  ["Q5", ["Q5"]],
  ["Q16334295", ["Q16334295"]],
  ["Q3305213", ["Q3305213", "Q386724"]],
]);

describe("makeInapplicableIdCheck", () => {
  const check = makeInapplicableIdCheck(
    new Map([
      ["P2799", [person]],
      ["P1", [{ classes: ["Q386724"], relation: "instance", exceptions: [] }]],
      ["P2", [{ classes: ["Q386724"], relation: "subclass", exceptions: [] }]],
      ["P3", [{ classes: ["Q386724"], relation: "either", exceptions: [] }]],
      ["P4", [person, { classes: ["Q47461344"], relation: "instance", exceptions: [] }]],
      ["P5", [{ ...person, exceptions: ["Q77336442"] }]],
    ]),
    ancestors,
  );
  const work = item("Q77336442", ["Q7725634"]);
  const human = item("Q1", ["Q5"]);

  it("rules out an item whose class the constraint doesn't cover", () => {
    expect(check("P2799", work)).toBe(true);
    expect(check("P2799", human)).toBe(false);
  });

  it("follows the class's ancestors for a constraint on a superclass", () => {
    expect(check("P1", work)).toBe(false);
    expect(check("P1", human)).toBe(true);
  });

  it("checks subclass of for a subclass relation, and both for either", () => {
    const genre = item("Q3305213", ["Q5"], ["Q3305213"]);
    expect(check("P2", work)).toBe(true); // an instance, not a subclass
    expect(check("P2", genre)).toBe(false);
    expect(check("P3", work)).toBe(false);
    expect(check("P3", genre)).toBe(false);
    expect(check("P3", human)).toBe(true);
    // A subclass relation is reflexive: the class itself fits.
    expect(check("P2", item("Q386724", ["Q1"]))).toBe(false);
  });

  it("needs every constraint to rule the item out", () => {
    expect(check("P4", work)).toBe(false);
    expect(check("P4", item("Q2", ["Q3305213"]))).toBe(true);
  });

  it("treats a listed exception as applicable", () => {
    expect(check("P5", work)).toBe(false);
    expect(check("P5", item("Q77336223", ["Q7725634"]))).toBe(true);
  });

  it("fails open on a property without constraints or a class without ancestor data", () => {
    expect(check("P999", work)).toBe(false);
    expect(check("P2799", item("Q3", ["Q999"]))).toBe(false);
    // One known class that fits nothing doesn't outweigh an unknown one.
    expect(check("P2799", item("Q3", ["Q7725634", "Q999"]))).toBe(false);
    expect(check("P2799", item("Q3", []))).toBe(false);
  });
});

describe("itemClasses", () => {
  it("lists the distinct instance of and subclass of values", () => {
    expect(itemClasses(item("Q1", ["Q5", "Q7"], ["Q5"]))).toEqual(["Q5", "Q7"]);
  });
});
