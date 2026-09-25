// The `instance of` (P31) classes the mirror holds. Shared by the dump import
// (which classes to import) and the candidates list (its type filter presets),
// so the filter offers exactly what the importer brings in.

/** "video game" — the first class the mirror held. */
export const VIDEO_GAME = "Q7889";

/** A named group of import classes, shown as one section of the type filter. */
export interface ImportClassGroup {
  name: string;
  classes: readonly { qid: string; label: string }[];
}

/**
 * The classes whose instances the mirror holds, grouped by the Wikidata
 * WikiProject that covers them (plus a catch-all for classes no listed
 * WikiProject owns). An item is imported when a best-rank `instance of` (P31)
 * names any of these. Only these exact QIDs match — subclasses are not
 * expanded — so add a class here to widen the mirror; the importer's
 * pre-filter needles, its P31 check, and the candidates list's type filter all
 * read this list. Each class belongs to exactly one group.
 */
export const IMPORT_CLASS_GROUPS: readonly ImportClassGroup[] = [
  {
    name: "WikiProject Video Games",
    classes: [
      { qid: VIDEO_GAME, label: "video game" },
      { qid: "Q7058673", label: "video game series" },
      { qid: "Q210167", label: "video game developer" },
      { qid: "Q1137109", label: "video game publisher" },
    ],
  },
  {
    name: "WikiProject Anime and Manga",
    classes: [{ qid: "Q63952888", label: "anime television series" }],
  },
  {
    name: "WikiProject Music",
    classes: [
      { qid: "Q134556", label: "single" },
      { qid: "Q169930", label: "extended play" },
      { qid: "Q482994", label: "album" },
      { qid: "Q7302866", label: "audio track" },
      { qid: "Q55850593", label: "music track with vocals" },
      { qid: "Q55850643", label: "music track without lyrics" },
      { qid: "Q215380", label: "musical group" },
      { qid: "Q18127", label: "record label" },
      { qid: "Q2442401", label: "record company" },
    ],
  },
  {
    name: "WikiProject Movies",
    classes: [
      { qid: "Q11424", label: "film" },
      { qid: "Q5398426", label: "television series" },
    ],
  },
  {
    name: "Other",
    classes: [{ qid: "Q783794", label: "company" }],
  },
];

/** Every import class, flattened in group order. */
export const IMPORT_CLASS_OPTIONS: readonly { qid: string; label: string }[] =
  IMPORT_CLASS_GROUPS.flatMap((g) => g.classes);

/** Just the QIDs of IMPORT_CLASS_OPTIONS. */
export const IMPORT_CLASSES: readonly string[] = IMPORT_CLASS_OPTIONS.map((c) => c.qid);
