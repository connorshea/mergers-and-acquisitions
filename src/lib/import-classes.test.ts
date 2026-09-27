import { describe, expect, it } from "vite-plus/test";
import {
  IMPORT_CLASS_GROUPS,
  IMPORT_CLASSES,
  SELECTIVE_IMPORT_CLASSES,
  VIDEO_GAME,
} from "./import-classes.ts";

describe("import classes", () => {
  it("files human under Other, not a WikiProject", () => {
    const home = IMPORT_CLASS_GROUPS.find((g) => g.classes.some((c) => c.qid === "Q5"));
    expect(home?.name).toBe("Other");
  });

  it("imports humans only selectively, linked from the video game classes", () => {
    expect(IMPORT_CLASSES).not.toContain("Q5");
    const human = SELECTIVE_IMPORT_CLASSES.find((c) => c.qid === "Q5");
    const games = IMPORT_CLASS_GROUPS.find((g) => g.name === "WikiProject Video Games");
    expect(human?.linkedFrom).toEqual(games?.classes.map((c) => c.qid));
    expect(human?.linkedFrom).toContain(VIDEO_GAME);
  });

  it("puts each class in exactly one group", () => {
    const qids = IMPORT_CLASS_GROUPS.flatMap((g) => g.classes.map((c) => c.qid));
    expect(new Set(qids).size).toBe(qids.length);
  });
});
