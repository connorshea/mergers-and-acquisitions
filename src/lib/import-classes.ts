// The `instance of` (P31) classes the mirror holds. Shared by the dump import
// (which classes to import) and the candidates list (its type filter presets),
// so the filter offers exactly what the importer brings in.

/** "video game" — the first class the mirror held. */
export const VIDEO_GAME = "Q7889";

/**
 * Which instances of a selective class to import, rather than all of them. An
 * instance is imported when any of these holds:
 * - an item of one of the `linkedFrom` classes links to it (any item-valued
 *   statement), as a game names its designer or voice actor;
 * - a best-rank `occupation` (P106) is one of `occupations`;
 * - it has a value for one of `idProperties`.
 * The last two find the duplicate that nothing links to yet: often a stub
 * made from a game database's entry, which the shared-id matching pairs.
 */
export interface SelectiveImport {
  linkedFrom: readonly string[];
  occupations: readonly string[];
  idProperties: readonly string[];
}

/** One class the mirror holds. */
export interface ImportClass {
  qid: string;
  label: string;
  /** Import only some instances (see SelectiveImport); SELECTIVE_IMPORT_CLASSES. */
  selective?: SelectiveImport;
  /**
   * A place at one spot, whose coordinate location (P625) pins it down: two
   * of them far apart are two places, however alike the names (see
   * POINT_PLACE_CLASSES).
   */
  pointPlace?: boolean;
}

/** The WikiProject Video Games classes; games link in the people they name. */
const VIDEO_GAME_CLASSES: readonly ImportClass[] = [
  { qid: VIDEO_GAME, label: "video game" },
  { qid: "Q7058673", label: "video game series" },
  { qid: "Q209163", label: "expansion add-on" },
  { qid: "Q1066707", label: "downloadable content" },
  { qid: "Q210167", label: "video game developer" },
  { qid: "Q1137109", label: "video game publisher" },
  { qid: "Q1569167", label: "video game character" },
  { qid: "Q865493", label: "video game mod" },
];

/**
 * The humans the mirror imports, out of Wikidata's ~13M: ~290k before
 * authors and musicians, ~760k with them (October 2026). Game people (~20k,
 * ~11k of them linked from games): the video game occupations under "game
 * designer" / "video game developer", professional gamers, and the game
 * databases' person ids. Anime staff (~17k more): anyone with an AniList or
 * MyAnimeList person id, which covers directors, animators, writers,
 * composers and voice actors. Olympians (~254k more): anyone with an id in one
 * of the multi-sport Olympic databases, which bulk imports each created their
 * own items from. Authors, musicians and other creators (~470k more): the
 * occupations below plus the book, comics and music databases' person ids.
 *
 * Left out for size (each is ~8-12 KB a person in the mirror, against a 25 GB
 * ToolsDB guideline, #192): other athletes (~1.4M under "athlete"), film and
 * TV people (~560k more with an IMDb id), the bare "writer" occupation (~450k
 * more: journalists, academics) and composers (~130k more). MusicBrainz
 * (~230k more) is left out too, though only for size: as a filter it would be
 * fine, since it isn't used as evidence.
 */
const PEOPLE: SelectiveImport = {
  linkedFrom: VIDEO_GAME_CLASSES.map((c) => c.qid),
  occupations: [
    "Q58287519", // video game developer
    "Q3630699", // game designer
    "Q18882335", // video game designer
    "Q2702296", // video game producer
    "Q63538345", // video game director
    "Q863368", // game programmer
    "Q3476620", // video game writer
    "Q6966205", // narrative designer
    "Q63852516", // level designer
    "Q107636670", // modder
    "Q9357633", // game tester
    "Q2872378", // video game author
    "Q4379701", // professional gamer
    "Q1544133", // board game designer
    "Q54845077", // role-playing game designer
    "Q2405480", // voice actor
    "Q266569", // animator
    "Q191633", // mangaka
    "Q715301", // comics artist
    "Q6625963", // novelist
    "Q18844224", // science fiction writer
    "Q4853732", // children's writer
    "Q49757", // poet
  ],
  idProperties: [
    "P3913", // MobyGames person ID
    "P5247", // Giant Bomb ID
    "P10918", // Liquipedia ID
    "P5796", // Internet Game Database person ID
    "P11227", // AniList staff ID
    "P4084", // MyAnimeList people ID
    "P8286", // Olympedia people ID
    "P5815", // Olympics.com athlete ID
    "P1447", // Sports-Reference.com Olympic athlete ID (archived)
    "P14105", // InterSportStats athlete ID
    "P4391", // The-Sports.org athlete ID
    "P1233", // ISFDB author ID
    "P2963", // Goodreads author ID
    "P7400", // LibraryThing author ID
    "P2607", // BookBrainz author ID
    "P5408", // Fantastic Fiction author ID
    "P5905", // Comic Vine ID
    "P5035", // Lambiek Comiclopedia artist ID
    "P1982", // Anime News Network person ID
    "P3505", // BoardGameGeek designer ID
    "P1953", // Discogs artist ID
    "P1728", // AllMusic artist ID
  ],
};

/** A named group of import classes, shown as one section of the type filter. */
export interface ImportClassGroup {
  name: string;
  classes: readonly ImportClass[];
}

/**
 * The classes whose instances the mirror holds, grouped by the Wikidata
 * WikiProject that covers them. An item is imported when a best-rank `instance of` (P31)
 * names any of these. Only these exact QIDs match — subclasses are not
 * expanded — so add a class here to widen the mirror; the importer's
 * pre-filter needles, its P31 check, and the candidates list's type filter all
 * read this list. Each class belongs to exactly one group; classes that span
 * WikiProjects go in "Other".
 */
export const IMPORT_CLASS_GROUPS: readonly ImportClassGroup[] = [
  {
    name: "WikiProject Anime and Manga",
    classes: [
      { qid: "Q63952888", label: "anime television series" },
      { qid: "Q100269041", label: "anime television series season" },
      { qid: "Q21198342", label: "manga series" },
      { qid: "Q104213567", label: "light novel series" },
      { qid: "Q20650540", label: "anime film" },
      { qid: "Q220898", label: "original video animation" },
    ],
  },
  {
    name: "WikiProject Board Games",
    classes: [
      { qid: "Q131436", label: "board game" },
      { qid: "Q1643932", label: "tabletop role-playing game" },
    ],
  },
  {
    name: "WikiProject Books",
    classes: [
      { qid: "Q7725634", label: "literary work" },
      { qid: "Q47461344", label: "written work" },
      { qid: "Q571", label: "book" },
    ],
  },
  {
    name: "WikiProject Comics",
    classes: [
      { qid: "Q1004", label: "comic" },
      { qid: "Q14406742", label: "comic book series" },
    ],
  },
  {
    name: "WikiProject Companies",
    classes: [
      { qid: "Q4830453", label: "business" },
      { qid: "Q6881511", label: "enterprise" },
      { qid: "Q783794", label: "company" },
    ],
  },
  {
    name: "WikiProject Fictional universes",
    // Wikidata's label is just "character"; spelled out so the type filter reads clearly.
    classes: [{ qid: "Q95074", label: "fictional character" }],
  },
  {
    name: "WikiProject Movies",
    classes: [
      { qid: "Q11424", label: "film" },
      { qid: "Q24862", label: "short film" },
      { qid: "Q202866", label: "animated film" },
      { qid: "Q506240", label: "television film" },
      { qid: "Q93204", label: "documentary film" },
      { qid: "Q24856", label: "film series" },
      { qid: "Q5398426", label: "television series" },
      { qid: "Q581714", label: "animated series" },
      { qid: "Q1259759", label: "miniseries" },
      { qid: "Q526877", label: "web series" },
      { qid: "Q15416", label: "television program" },
      { qid: "Q1261214", label: "television special" },
    ],
  },
  {
    name: "WikiProject Museums",
    classes: [
      { qid: "Q33506", label: "museum", pointPlace: true },
      { qid: "Q207694", label: "art museum", pointPlace: true },
    ],
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
      { qid: "Q105543609", label: "musical work/composition" },
      { qid: "Q215380", label: "musical group" },
      { qid: "Q18127", label: "record label" },
      { qid: "Q2442401", label: "record company" },
    ],
  },
  {
    name: "WikiProject Podcasts",
    classes: [{ qid: "Q24634210", label: "podcast show" }],
  },
  {
    name: "WikiProject Railways",
    classes: [{ qid: "Q55488", label: "railway station", pointPlace: true }],
  },
  {
    name: "WikiProject Sports",
    classes: [{ qid: "Q483110", label: "stadium", pointPlace: true }],
  },
  {
    name: "WikiProject Video Games",
    classes: VIDEO_GAME_CLASSES,
  },
  {
    // Classes that span WikiProjects: the people are drawn from several.
    name: "Other",
    classes: [{ qid: "Q5", label: "human", selective: PEOPLE }],
  },
];

/** Every import class, flattened in group order. */
export const IMPORT_CLASS_OPTIONS: readonly ImportClass[] = IMPORT_CLASS_GROUPS.flatMap(
  (g) => g.classes,
);

/** The QIDs of the classes whose every instance is imported. */
export const IMPORT_CLASSES: readonly string[] = IMPORT_CLASS_OPTIONS.filter(
  (c) => !c.selective,
).map((c) => c.qid);

/** A class of which only some instances are imported (see SelectiveImport). */
export interface SelectiveImportClass extends SelectiveImport {
  qid: string;
}

/** The `selective` classes, each with the lists that pick its instances. */
export const SELECTIVE_IMPORT_CLASSES: readonly SelectiveImportClass[] =
  IMPORT_CLASS_OPTIONS.flatMap((c) => (c.selective ? [{ qid: c.qid, ...c.selective }] : []));

/**
 * The point-place classes (ImportClass.pointPlace): museums, stations,
 * stadiums. Not rivers, mountains or regions, whose one coordinate can be any
 * of several far-apart points (a river's source or mouth).
 */
export const POINT_PLACE_CLASSES: ReadonlySet<string> = new Set(
  IMPORT_CLASS_OPTIONS.filter((c) => c.pointPlace).map((c) => c.qid),
);
