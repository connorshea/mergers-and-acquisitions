// Wikidata item comparison heuristics.
//
// This module is intentionally DOM-free and dependency-free so it can be shared
// by the React UI, the server routes, and the background jobs (sync +
// candidate hunting). Keep it that way — no React, no browser globals.

// ---------- Types ----------

// "somevalue" / "novalue" mirror Wikidata's special snak types: an *unknown*
// value (a value exists but isn't recorded — a blank node on the wire) and an
// explicit *no* value (the property is asserted to have none). They carry no
// meaningful `value` string.
export type ValueType =
  | "item"
  | "string"
  | "time"
  | "quantity"
  | "url"
  | "external-id"
  | "somevalue"
  | "novalue";

export interface Value {
  type: ValueType;
  value: string;
  /** Human label for item values; ignored otherwise. */
  label?: string;
}

export interface Item {
  id: string;
  labels: Record<string, string>;
  descriptions: Record<string, string>;
  aliases: Record<string, string[]>;
  sitelinks: Record<string, string>;
  statements: Record<string, Value[]>;
}

export type Status = "identical" | "similar" | "distinct";
/** Row-level category: a row is one-sided when only one item has any value for it. */
export type RowStatus = Status | "one-sided";

export interface AnnotatedValue extends Value {
  status: Status; // how this value relates to the other side
  note?: string;
}

export interface Row {
  key: string; // e.g. "P31" or "label:en" or "sitelink:enwiki"
  label: string;
  kind: "term" | "sitelink" | "statement";
  status: RowStatus;
  blocker: boolean; // wbmergeitems would reject without ignoreconflicts
  a: AnnotatedValue[];
  b: AnnotatedValue[];
  note?: string;
}

// ---------- Property labels ----------

export const PROPERTY_LABELS: Record<string, string> = {
  P31: "instance of",
  P136: "genre",
  P178: "developer",
  P123: "publisher",
  P400: "platform",
  P577: "publication date",
  P856: "official website",
  P1733: "Steam application ID",
  P2725: "GOG application ID",
  P404: "game mode",
  P1476: "title",
  P569: "date of birth",
  P27: "country of citizenship",
  P106: "occupation",
  P214: "VIAF ID",
  P2002: "X username",
  P57: "director",
  P50: "author",
  P495: "country of origin",
  P571: "inception",
  P159: "headquarters location",
  P1128: "employees",
  P1441: "present in work",
};

// ---------- Comparison ----------

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/^https?:\/\/(www\.)?/, "")
    .replace(/\/+$/, "")
    .replace(/\s+/g, " ");
}

export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[n];
}

export function stringSimilarity(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return 1;
  const max = Math.max(na.length, nb.length);
  return max === 0 ? 1 : 1 - levenshtein(na, nb) / max;
}

/**
 * Blocking key for a label: a deliberately looser normalization than
 * `normalize()` used only to decide which items are *considered* as a pair (see
 * the label+type route in queues/hunt-candidates.ts). It drops punctuation and
 * symbols so titles that differ only in punctuation land in the same bucket —
 * e.g. "Go West: A Lucky Luke Adventure" and "Go West! A Lucky Luke Adventure",
 * or straight vs. curly apostrophes and en/em dashes. Letters (incl. accented)
 * and digits are kept, so sequels ("Portal" vs "Portal 2") stay distinct. This
 * only widens what gets scored; scoreCandidate still gates the result, so a
 * looser key can't by itself create a false positive.
 */
export function blockingLabelKey(label: string): string {
  return normalize(label)
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Build the external URL for an identifier value from a Wikidata formatter URL
 * (P1630), substituting the value for the `$1` placeholder — e.g.
 * ("https://store.steampowered.com/app/$1/", "268220") →
 * "https://store.steampowered.com/app/268220/". Returns null when there is no
 * template or it has no placeholder, so callers can fall back to plain text.
 */
export function formatIdUrl(template: string | undefined, value: string): string | null {
  if (!template || !template.includes("$1")) return null;
  return template.split("$1").join(value);
}

/** Returns [status, note] for a pair of values of the same property. */
export function compareValues(x: Value, y: Value): [Status, string?] {
  if (x.type !== y.type) return ["distinct"];
  // Unknown value (somevalue): a value exists but isn't recorded, so two of them
  // can't be confirmed equal — never an identical match, and their (blank-node)
  // `value` strings must not be compared. No value (novalue): an explicit
  // assertion of absence, so two of them agree.
  if (x.type === "somevalue") return ["distinct", "unknown value on both sides"];
  if (x.type === "novalue") return ["identical"];
  if (x.value === y.value) return ["identical"];

  switch (x.type) {
    case "item":
      // Different QIDs; fall back to label similarity as a hint only.
      if (x.label && y.label && stringSimilarity(x.label, y.label) >= 0.6)
        return ["similar", "different items with similar labels"];
      return ["distinct"];
    case "time": {
      // Wikidata times are `±YYYY-MM-DDThh:mm:ssZ`; a "00" month or day marks an
      // unspecified (coarser-precision) part, e.g. year precision is
      // `+2022-00-00T…`. Parse the calendar parts so we can tell an actual
      // difference (a day off) from a genuine precision mismatch.
      const parse = (s: string): { y: number; mo: number; d: number } | null => {
        const m = /^([+-]?\d+)-(\d\d)-(\d\d)/.exec(s);
        return m ? { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) } : null;
      };
      const da = parse(x.value);
      const db = parse(y.value);
      if (!da || !db)
        return x.value.slice(0, 4) === y.value.slice(0, 4)
          ? ["similar", "same year"]
          : ["distinct"];
      if (da.y !== db.y) return ["distinct"];
      // Same year. Precision = how many calendar parts are specified.
      const precision = (p: { mo: number; d: number }): number =>
        p.mo === 0 ? 1 : p.d === 0 ? 2 : 3;
      if (precision(da) !== precision(db)) return ["similar", "same year, different precision"];
      // Same precision, same year — report how they actually differ. (An exact
      // match was already returned above, so something differs here.)
      if (da.mo !== db.mo) return ["similar", "same year, different month"];
      const gap = Math.abs(da.d - db.d);
      return ["similar", gap === 1 ? "one day apart" : `${gap} days apart`];
    }
    case "quantity":
    case "external-id":
      return ["distinct"]; // must match exactly
    case "url":
      if (normalize(x.value) === normalize(y.value)) return ["similar", "same host and path"];
      return ["distinct"];
    case "string": {
      const s = stringSimilarity(x.value, y.value);
      if (s === 1) return ["similar", "equal after normalization"];
      if (s >= 0.75) return ["similar", `${Math.round(s * 100)}% string match`];
      return ["distinct"];
    }
  }
}

export function compareSets(
  a: Value[],
  b: Value[],
): { status: Status; a: AnnotatedValue[]; b: AnnotatedValue[] } {
  const annotate = (side: Value[], other: Value[]): AnnotatedValue[] =>
    side.map((v) => {
      let best: Status = "distinct";
      let note: string | undefined;
      for (const o of other) {
        const [s, n] = compareValues(v, o);
        if (s === "identical") return { ...v, status: s };
        if (s === "similar" && best !== "similar") {
          best = "similar";
          note = n;
        }
      }
      return { ...v, status: best, note };
    });

  const aa = annotate(a, b);
  const bb = annotate(b, a);
  const all = [...aa, ...bb];
  let status: Status;
  if (all.every((v) => v.status === "identical")) status = "identical";
  else if (all.some((v) => v.status !== "distinct")) status = "similar";
  else status = "distinct";
  return { status, a: aa, b: bb };
}

/**
 * Build the field-by-field comparison rows for a pair. `propertyLabels` (Pxxx →
 * human label) is an optional DB-backed override; it falls back to the built-in
 * PROPERTY_LABELS map and finally to the bare property id. `valueLabels` (Qxxx →
 * human label) backfills the display label of item-valued statements whose
 * label the sync didn't resolve, so genre/platform/etc. show a name instead of
 * a bare QID; it's ignored for non-item values.
 */
export function buildRows(
  a: Item,
  b: Item,
  propertyLabels: Record<string, string> = {},
  valueLabels: Record<string, string> = {},
): Row[] {
  const rows: Row[] = [];

  // Backfill a display label for item values missing one, from valueLabels.
  const withLabels = (values: Value[]): Value[] =>
    values.map((v) =>
      v.type === "item" && !v.label && valueLabels[v.value]
        ? { ...v, label: valueLabels[v.value] }
        : v,
    );

  /**
   * Label/alias values are also checked against the *other* term kind on the
   * opposite item (an alias here vs. the label there, and vice versa), so a
   * renamed or re-aliased item still shows up as similar rather than distinct.
   */
  const termRow = (
    key: string,
    label: string,
    va: string[],
    vb: string[],
    blocker: boolean,
    cross?: { a: string[]; b: string[]; what: string },
  ) => {
    const cmp = compareSets(
      va.map((v) => ({ type: "string" as const, value: v })),
      vb.map((v) => ({ type: "string" as const, value: v })),
    );
    let crossMatched = false;
    if (cross) {
      const mark = (vals: AnnotatedValue[], pool: string[], otherId: string) => {
        for (const v of vals) {
          if (v.status === "identical") continue;
          if (pool.some((p) => normalize(p) === normalize(v.value))) {
            v.status = "similar";
            v.note = `matches ${cross.what} on ${otherId}`;
            crossMatched = true;
          }
        }
      };
      mark(cmp.a, cross.b, b.id);
      mark(cmp.b, cross.a, a.id);
    }
    const oneSided = (va.length === 0 || vb.length === 0) && !crossMatched;
    const all = [...cmp.a, ...cmp.b];
    let status: RowStatus;
    if (oneSided) status = "one-sided";
    else if (all.every((v) => v.status === "identical")) status = "identical";
    else if (all.some((v) => v.status !== "distinct")) status = "similar";
    else status = "distinct";
    rows.push({
      key,
      label,
      kind: "term",
      status,
      blocker: blocker && status !== "identical" && status !== "one-sided",
      a: cmp.a,
      b: cmp.b,
    });
  };

  const langs = (o: Record<string, unknown>, p: Record<string, unknown>) =>
    Array.from(new Set([...Object.keys(o), ...Object.keys(p)])).sort();

  for (const l of langs(a.labels, b.labels))
    termRow(
      `label:${l}`,
      `label (${l})`,
      a.labels[l] ? [a.labels[l]] : [],
      b.labels[l] ? [b.labels[l]] : [],
      false,
      {
        a: a.aliases[l] ?? [],
        b: b.aliases[l] ?? [],
        what: "an alias",
      },
    );
  for (const l of langs(a.descriptions, b.descriptions))
    termRow(
      `description:${l}`,
      `description (${l})`,
      a.descriptions[l] ? [a.descriptions[l]] : [],
      b.descriptions[l] ? [b.descriptions[l]] : [],
      true, // conflicting descriptions block wbmergeitems unless ignoreconflicts=description
    );
  for (const l of langs(a.aliases, b.aliases))
    termRow(`alias:${l}`, `aliases (${l})`, a.aliases[l] ?? [], b.aliases[l] ?? [], false, {
      a: a.labels[l] ? [a.labels[l]] : [],
      b: b.labels[l] ? [b.labels[l]] : [],
      what: "the label",
    });

  for (const wiki of langs(a.sitelinks, b.sitelinks)) {
    const va = a.sitelinks[wiki] ? [{ type: "string" as const, value: a.sitelinks[wiki] }] : [];
    const vb = b.sitelinks[wiki] ? [{ type: "string" as const, value: b.sitelinks[wiki] }] : [];
    const cmp = compareSets(va, vb);
    const oneSided = va.length === 0 || vb.length === 0;
    rows.push({
      key: `sitelink:${wiki}`,
      label: wiki,
      kind: "sitelink",
      status: oneSided ? "one-sided" : cmp.status,
      blocker: !oneSided && cmp.status !== "identical",
      a: cmp.a,
      b: cmp.b,
      note:
        !oneSided && cmp.status !== "identical"
          ? "two different pages on the same wiki — a real merge would need one removed first"
          : undefined,
    });
  }

  for (const pid of langs(a.statements, b.statements)) {
    const va = withLabels(a.statements[pid] ?? []);
    const vb = withLabels(b.statements[pid] ?? []);
    const cmp = compareSets(va, vb);
    const oneSided = va.length === 0 || vb.length === 0;
    rows.push({
      key: pid,
      label: propertyLabels[pid] ?? PROPERTY_LABELS[pid] ?? pid,
      kind: "statement",
      status: oneSided ? "one-sided" : cmp.status,
      blocker: false,
      a: cmp.a,
      b: cmp.b,
    });
  }

  return rows;
}

/** Wikidata convention: the newer (higher-numbered) item is merged into the older one. */
export function orderByAge(x: Item, y: Item): [from: Item, into: Item] {
  const n = (id: string) => parseInt(id.replace(/^Q/, ""), 10);
  return n(x.id) > n(y.id) ? [x, y] : [y, x];
}

// ---------- Confidence scoring ----------

/**
 * External-identifier properties that identify an *account or franchise*, not a
 * single title — a developer's Facebook page or a series' Twitter handle is the
 * same across their whole catalog, so a shared value here is weak evidence of a
 * duplicate (it's exactly what makes a game and its sequel look identical).
 * Per-title store/database IDs (Steam, GOG, MobyGames, …) are not listed and
 * keep their full weight.
 */
const WEAK_ID_PROPS = new Set<string>([
  "P2013", // Facebook ID
  "P2002", // X/Twitter username
  "P2003", // Instagram username
  "P2397", // YouTube channel ID
  "P7085", // TikTok username
  "P3789", // Telegram
  "P4264", // LinkedIn company ID
  "P2984", // Snapchat
  "P6634", // LinkedIn personal profile ID
  "P1581", // official blog URL
  "P3185", // VK username
  // Series/franchise-level catalogue IDs — one page often covers a whole series,
  // so a shared value doesn't mean two items are the same *title* (e.g. a game
  // and its sequel share a TV Tropes or speedrun.com page).
  "P6839", // TV Tropes ID
  "P6783", // speedrun.com game ID
]);

/**
 * Ubiquitous, low-information item-valued properties. Thousands of unrelated
 * games share these exact values ("single-player", "action game", a country),
 * so agreement on them is near-meaningless and must not inflate the
 * statement-agreement signal — it's excluded from that term entirely. Genuinely
 * discriminative properties (developer, publisher, per-title ids) keep full
 * weight. Series (P179) is here too: sharing a series is at best a weak hint of
 * sameness — every entry in a franchise shares it, and a sequel is not a
 * duplicate — so it must not inflate the match signal.
 */
const LOW_ENTROPY_PROPS = new Set<string>([
  "P136", // genre
  "P404", // game mode
  "P495", // country of origin
  "P407", // language of work or name
  "P179", // part of the series (a whole franchise shares it; weak match evidence)
]);

/**
 * Identifiers that third-party databases populate *from* Wikidata rather than
 * independently (they mirror Wikidata's own item mapping). A shared value is
 * therefore circular — not independent evidence the two items are the same — and
 * a differing value only means one side hasn't been re-synced, not that the
 * subjects are distinct. Ignore them as an identifier signal in both directions
 * (neither a match nor a distinction).
 *
 * This is a hardcoded *floor*, unioned at runtime with the synced set of
 * properties tagged P31 = Q24075706 ("authority control with reciprocal use of
 * Wikidata") via ScoreOptions.isMirroredIdProp. The floor guarantees correct
 * behaviour before the first property sync and in callers that pass no options
 * (the unit tests), and additionally covers services Wikidata hasn't tagged
 * (GamerProfiles). Once synced, the (much larger) tagged set handles the rest —
 * including vglist — and stays current without edits here.
 */
const MIRRORED_ID_PROPS = new Set<string>([
  "P8351", // vglist video game ID (also tagged P31=Q24075706, so synced too)
  "P12001", // GamerProfiles game ID — mirrors Wikidata but untagged (P31≠Q24075706)
]);

/**
 * Whether a property is a *hardcoded* Wikidata-mirroring identifier (the
 * MIRRORED_ID_PROPS floor). This is the subset that callers without the synced
 * `properties.mirrors_wikidata` set — chiefly the UI — can recognise on their
 * own, and notably includes services Wikidata hasn't tagged P31=Q24075706 (e.g.
 * GamerProfiles). The full runtime predicate additionally unions the synced set;
 * see ScoreOptions.isMirroredIdProp.
 */
export function isHardcodedMirrorProp(pid: string): boolean {
  return MIRRORED_ID_PROPS.has(pid);
}

/**
 * A publication-year gap at or beyond this is treated as near-conclusive that
 * two items are different games/editions: no single game is first published a
 * decade-plus apart, so even a shared external identifier (more likely stale or
 * mis-entered data than a real match) is outweighed. See scoreCandidate.
 */
const LARGE_YEAR_GAP = 10;

/**
 * Per-title identifiers where each distinct game has exactly one page: a
 * specific store or database entry for one title. If two items each carry their
 * *own differing* value for two or more of these, they point at two different
 * store/database pages — near-conclusive that they are different games, even if
 * some other id happens to collide (a shared id across differing store pages is
 * far more likely stale/mis-entered than a real match). A single differing id
 * can be a data-entry slip; two or more is a pattern. One-sided ids — present on
 * only one item — never count. (itch.io URL is a `url` datatype, not an
 * ExternalId, so this set is matched by property id rather than value shape.)
 */
const PER_TITLE_ID_PROPS = new Set<string>([
  "P1733", // Steam application ID
  "P6337", // PCGamingWiki ID
  "P11688", // MobyGames game ID
  "P5794", // IGDB game ID
  "P7294", // itch.io URL
  "P5247", // Giant Bomb ID
]);

const ROMAN_RE = /^m{0,3}(cm|cd|d?c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})$/i;

/** Parse a Roman numeral (i–mmmm range); null if not a well-formed numeral. */
function romanToInt(s: string): number | null {
  const t = s.toLowerCase();
  if (!t || !ROMAN_RE.test(t)) return null;
  const map: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
  let total = 0;
  for (let i = 0; i < t.length; i++) {
    const cur = map[t[i]];
    const next = map[t[i + 1]] ?? 0;
    total += cur < next ? -cur : cur;
  }
  return total;
}

/**
 * Split a title into its base and a trailing installment number, e.g.
 * "Revenge on the Streets 2" → { base: "revenge on the streets", num: 2 } and
 * "Final Fantasy VII" → { base: "final fantasy", num: 7 }. `num` is null when
 * there's no trailing arabic/Roman number.
 */
export function installment(label: string): { base: string; num: number | null } {
  const norm = normalize(label);
  const m = norm.match(/^(.+?)[\s:._-]+([0-9]{1,4}|[ivxlcdm]+)$/i);
  if (!m) return { base: norm, num: null };
  const base = m[1].trim();
  const tok = m[2];
  const num = /^[0-9]+$/.test(tok) ? parseInt(tok, 10) : romanToInt(tok);
  if (num === null || base.length === 0) return { base: norm, num: null };
  return { base, num };
}

function bestLabel(item: Item): string {
  return item.labels.en ?? item.labels.mul ?? Object.values(item.labels)[0] ?? "";
}

/** Every label (and, optionally, alias) string an item carries, across languages. */
function nameStrings(item: Item, includeAliases: boolean): string[] {
  const out = Object.values(item.labels);
  if (includeAliases) for (const arr of Object.values(item.aliases)) out.push(...arr);
  return out.filter(Boolean);
}

/**
 * Best string similarity (0–1) between any name of `a` and any name of `b`.
 * With `includeAliases` (the default) it also considers aliases on both sides,
 * so a rename — where the label differs but matches the other item's alias —
 * still reads as a match. With it off, only labels are compared, which lets the
 * caller tell an outright identical label from an alias-only match.
 */
export function bestNameSimilarity(a: Item, b: Item, includeAliases = true): number {
  const as = nameStrings(a, includeAliases);
  const bs = nameStrings(b, includeAliases);
  if (as.length === 0 || bs.length === 0) return 0;
  let best = 0;
  for (const x of as) {
    for (const y of bs) {
      best = Math.max(best, stringSimilarity(x, y));
      if (best === 1) return 1;
    }
  }
  return best;
}

/**
 * True when two titles are different entries in the same series (a sequel), not
 * duplicates — same base, but different (or present-vs-absent) installment
 * numbers, e.g. "X" vs "X 2" or "X II" vs "X III".
 */
export function isSeriesSequelPair(a: Item, b: Item): boolean {
  const ia = installment(bestLabel(a));
  const ib = installment(bestLabel(b));
  if (!ia.base || ia.base !== ib.base) return false;
  if (ia.num === null && ib.num === null) return false;
  return ia.num !== ib.num;
}

/** Wikidata "different from" — an explicit statement that two items are distinct. */
export const DIFFERENT_FROM = "P1889";

/**
 * True when either item carries a `different from` (P1889) statement pointing at
 * the other. Editors add this precisely to stop two look-alike items being
 * confused or merged, so it is authoritative: a declared-different pair is never
 * a duplicate, whatever the other signals say.
 */
export function isDeclaredDifferent(a: Item, b: Item): boolean {
  const points = (from: Item, toId: string) =>
    (from.statements[DIFFERENT_FROM] ?? []).some((v) => v.type === "item" && v.value === toId);
  return points(a, b.id) || points(b, a.id);
}

export interface CandidateScore {
  /** 0–1 likelihood the two items are the same subject and should be merged. */
  confidence: number;
  /** Human-readable signals that fed the score. */
  reasons: string[];
  /** Whether a real wbmergeitems call would hit a conflict (description / same-wiki sitelink). */
  hasBlocker: boolean;
}

/**
 * Heuristic duplicate-confidence score for a pair of items, built on top of
 * buildRows. Combines a handful of signals — shared external identifiers, same
 * vs. different `instance of` (P31), name similarity/distinctness (labels and
 * aliases, so renames still match), and how much of the shared statements agree
 * — into a 0–1 score. Concrete disagreement subtracts too: a differing release
 * year, developer, or publisher (unless a shared strong per-title id vouches for
 * the pair — except a *large* publication-year gap, which overrides even that).
 * A near-certain (≈1.0) score is *reserved*: it takes a very similar name plus
 * strong corroboration — two or more shared external ids, or an id plus agreeing
 * discriminative properties — and minimal differences. A lone shared id with a
 * matching name is strong but not conclusive and is capped below 1.0; any
 * concrete difference (differing developer/publisher, a year gap, or a single
 * conflicting per-title id like two different Steam pages) caps it further.
 * Two strong negatives can effectively disqualify a pair: clearly-different
 * names, and many external identifiers that are present on both items yet all
 * differ. More narrowly, two or more differing *per-title* identifiers (Steam,
 * PCGamingWiki, MobyGames, IGDB, itch.io, Giant Bomb) point at distinct
 * store/database pages and cap the score hard, overriding even a shared id.
 * Identifiers that mirror Wikidata itself (vglist, GamerProfiles) are
 * ignored as evidence in either direction. Blockers (conflicting descriptions or same-wiki
 * sitelinks) are surfaced via `hasBlocker` but do not by themselves sink the
 * score: real duplicates routinely have conflicting descriptions.
 */
export interface ScoreOptions {
  /**
   * Predicate for whether a property id is a genuine external *identifier*
   * (Wikidata datatype = ExternalId). Value-shape classification can't tell a
   * real id from a bare-literal non-id like `review score` (P444) or a rating,
   * whose values ("71/100") collide across unrelated games. When supplied, only
   * matching properties count toward the shared-identifier signal. When omitted
   * (e.g. properties aren't synced yet), every external-id-shaped value counts,
   * as before.
   */
  isIdentifierProp?: (pid: string) => boolean;
  /**
   * Predicate for whether a property mirrors Wikidata — an authority-control id
   * whose service sources its ids *from* Wikidata (P31 = Q24075706: vglist,
   * VNDB, MusicBrainz, …). Such ids are minted per Wikidata item, so a shared
   * value is circular and a differing value is not evidence of distinct
   * subjects: they count neither for a match nor against one. Unioned with the
   * hardcoded MIRRORED_ID_PROPS (which also covers services Wikidata hasn't
   * tagged, e.g. GamerProfiles). Supplied by the hunt from the synced
   * `properties.mirrors_wikidata`; omitted before the first property sync.
   */
  isMirroredIdProp?: (pid: string) => boolean;
}

export function scoreCandidate(a: Item, b: Item, opts: ScoreOptions = {}): CandidateScore {
  const rows = buildRows(a, b);
  const reasons: string[] = [];
  let score = 0;

  // Shared external identifiers are the strongest single signal — but only
  // genuine per-title identifiers. Restrict to real ExternalId properties when
  // we can (opts.isIdentifierProp), which drops non-id lookalikes like review
  // scores, then further split out account/franchise ids (WEAK_ID_PROPS) that a
  // game shares with its whole series.
  const isId = opts.isIdentifierProp;
  // A property mirrors Wikidata if it's in the hardcoded floor OR the synced set
  // (P31 = Q24075706) says so. Such ids are excluded as evidence in both
  // directions — neither a shared value nor a differing one means anything.
  const isMirrored = (pid: string): boolean =>
    MIRRORED_ID_PROPS.has(pid) || (opts.isMirroredIdProp?.(pid) ?? false);
  const sharedExtIds = rows.filter(
    (r) =>
      r.kind === "statement" &&
      r.status === "identical" &&
      r.a.some((v) => v.type === "external-id") &&
      !isMirrored(r.key) &&
      (isId ? isId(r.key) : true),
  );
  const strongIds = sharedExtIds.filter((r) => !WEAK_ID_PROPS.has(r.key));
  const weakIds = sharedExtIds.filter((r) => WEAK_ID_PROPS.has(r.key));
  if (strongIds.length > 0) {
    score += 0.6;
    reasons.push(`shares external identifier: ${strongIds.map((r) => r.label).join(", ")}`);
  } else if (weakIds.length > 0) {
    score += 0.1;
    reasons.push(`shares account/social identifier: ${weakIds.map((r) => r.label).join(", ")}`);
  }

  // Instance of (P31): agreement is necessary but far from sufficient — nearly
  // every in-scope pair shares it (all video games are P31=Q7889), so it barely
  // distinguishes anything and gets only a token boost. Disagreement, on the
  // other hand, strongly opposes a merge.
  const p31 = rows.find((r) => r.key === "P31");
  if (p31) {
    if (p31.status === "identical") {
      score += 0.1;
      reasons.push("same instance of (P31)");
    } else if (p31.status === "distinct") {
      score -= 0.45;
      reasons.push("different instance of (P31)");
    }
  }

  // Name agreement/distinctness — the single strongest distinguisher between a
  // real duplicate and two different games that merely share a type and a couple
  // of properties. It both rewards matches and *penalises* clearly-distinct
  // names. Aliases count on both sides, so a rename (label differs but matches
  // the other item's alias) still reads as a match; comparing labels-only lets
  // us tell an outright identical label from an alias-only match in the reason.
  const nameSim = bestNameSimilarity(a, b);
  const labelSim = bestNameSimilarity(a, b, false);
  const namePct = Math.round(nameSim * 100);
  if (nameSim >= 0.995) {
    score += 0.35;
    reasons.push(labelSim >= 0.995 ? "identical label" : "label matches the other item's alias");
  } else if (nameSim >= 0.75) {
    score += 0.2;
    reasons.push(`very similar names (${namePct}%)`);
  } else if (nameSim >= 0.5) {
    score += 0.05;
    reasons.push(`loosely similar names (${namePct}%)`);
  } else {
    score -= 0.35;
    reasons.push(`different names (${namePct}%)`);
  }

  // How much of the shared statement set agrees, over *discriminative* properties
  // only (P31 counted above; low-entropy props like genre/game mode/country
  // excluded, since agreeing on "single-player" says nothing about sameness).
  const stmtRows = rows.filter(
    (r) => r.kind === "statement" && r.key !== "P31" && !LOW_ENTROPY_PROPS.has(r.key),
  );
  const agreeing = stmtRows.filter((r) => r.status === "identical" || r.status === "similar");
  if (stmtRows.length > 0 && agreeing.length > 0) {
    score += 0.2 * (agreeing.length / stmtRows.length);
    reasons.push(`${agreeing.length} of ${stmtRows.length} shared statements agree`);
  }

  // Publication-year disagreement. Take the closest pair of release years across
  // the two items, so a re-release date listed on one side doesn't trip it.
  const years = (item: Item): number[] =>
    (item.statements.P577 ?? [])
      .filter((v) => v.type === "time")
      .map((v) => parseInt(v.value.slice(0, 4), 10))
      .filter((n) => Number.isFinite(n));
  const ya = years(a);
  const yb = years(b);
  let yearGap = Infinity;
  if (ya.length > 0 && yb.length > 0) {
    for (const x of ya) for (const y of yb) yearGap = Math.min(yearGap, Math.abs(x - y));
  }

  // A large gap is near-conclusive evidence of different games/editions and
  // overrides even a shared identifier — a shared id across a decade-plus gap is
  // far more likely stale/mis-entered data than a real match (e.g. two unrelated
  // "Meltdown" games, 1986 vs. 2014, that happen to collide on a catalogue id).
  // Cap below the persistence floor so the pair never surfaces.
  if (Number.isFinite(yearGap) && yearGap >= LARGE_YEAR_GAP) {
    reasons.unshift(`publication years differ by ${yearGap} — almost certainly different games`);
    score = Math.min(score, 0.1);
  }

  // Concrete disagreements on discriminative facts. Computed unconditionally (a
  // shared strong id suppresses the *penalties* below but these differences still
  // feed the confidence ceiling, so "minimal differences" is required to reach the
  // very top of the range).
  const itemValues = (item: Item, pid: string): string[] =>
    (item.statements[pid] ?? []).filter((v) => v.type === "item").map((v) => v.value);
  const disjoint = (pid: string): boolean => {
    const va = itemValues(a, pid);
    const vb = itemValues(b, pid);
    return va.length > 0 && vb.length > 0 && !va.some((v) => vb.includes(v));
  };
  const diffDeveloper = disjoint("P178");
  const diffPublisher = disjoint("P123");
  const modestYearGap = Number.isFinite(yearGap) && yearGap >= 2 && yearGap < LARGE_YEAR_GAP;

  // Lesser disagreement penalties. A shared strong per-title identifier is near-
  // conclusive for these, so when we have one we trust it and skip the *penalties*
  // (a small release-date or renamed-studio mismatch shouldn't sink a genuine
  // duplicate). Otherwise, concrete disagreement — a modest release-year gap, the
  // developer, the publisher — is strong evidence of two different games that
  // merely share a title.
  if (strongIds.length === 0) {
    if (modestYearGap) {
      const penalty = Math.min(0.35, 0.25 + (yearGap - 2) / 30);
      score -= penalty;
      reasons.push(`publication years differ by ${yearGap}`);
    }
    if (diffDeveloper) {
      score -= 0.25;
      reasons.push("different developer");
    }
    if (diffPublisher) {
      score -= 0.2;
      reasons.push("different publisher");
    }
  }

  const blockers = rows.filter((r) => r.blocker);
  if (blockers.length > 0) {
    reasons.push(
      `${blockers.length} conflict${blockers.length > 1 ? "s" : ""} would block the merge`,
    );
  }

  // Many external identifiers held by *both* items with entirely different
  // values are near-conclusive evidence of two distinct subjects: a single game
  // has one Steam/GOG/MobyGames/etc. page, so if each item carries its own set of
  // store/database ids and none of them agree, they are almost certainly not the
  // same game. Only real ExternalId properties count (when we can tell), so a
  // shared non-id literal like a review score never trips this.
  const distinctExtIdRows = rows.filter(
    (r) =>
      r.kind === "statement" &&
      r.status === "distinct" &&
      r.a.some((v) => v.type === "external-id") &&
      r.b.some((v) => v.type === "external-id") &&
      !isMirrored(r.key) &&
      (isId ? isId(r.key) : true),
  );
  if (distinctExtIdRows.length > 6) {
    reasons.unshift(
      `${distinctExtIdRows.length} external identifiers differ across the pair — almost certainly different subjects`,
    );
    score = Math.min(score, 0.05);
  }

  // Two or more *per-title* identifiers (Steam, PCGamingWiki, MobyGames, IGDB,
  // itch.io, Giant Bomb) present on both items with differing values means the
  // pair points at two distinct store/database pages — near-conclusive that they
  // are different games. Cap hard, below the persistence floor, overriding even a
  // shared id. (Ids present on only one side are "one-sided", not "distinct", and
  // don't count.)
  const distinctPerTitleIds = rows.filter(
    (r) => r.kind === "statement" && r.status === "distinct" && PER_TITLE_ID_PROPS.has(r.key),
  );
  if (distinctPerTitleIds.length >= 2) {
    reasons.unshift(
      `${distinctPerTitleIds.length} per-title identifiers differ (${distinctPerTitleIds
        .map((r) => r.label)
        .join(", ")}) — almost certainly different games`,
    );
    score = Math.min(score, 0.1);
  } else if (distinctPerTitleIds.length === 1) {
    // A single differing per-title id (e.g. two different Steam or itch.io pages)
    // is a real discrepancy — usually different games, occasionally a data slip
    // when a stronger id still agrees. Dock it modestly and (via the ceiling
    // below) hold the pair well off a near-certain score, but keep the nudge
    // small so a genuine duplicate with one mis-entered id stays a candidate.
    score -= 0.1;
    reasons.push(
      `a per-title identifier differs (${distinctPerTitleIds[0].label}) — points at a different store/database page`,
    );
  }

  // A sequel is not a duplicate. Different entries in the same series share a
  // developer, genre, platforms and often an account-level id, so they'd
  // otherwise score very high — cap them below the persistence floor so they
  // never surface as candidates.
  if (isSeriesSequelPair(a, b)) {
    reasons.unshift("different entries in a series (sequel), not a duplicate");
    score = Math.min(score, 0.1);
  }

  // A "different from" (P1889) statement is an editor explicitly declaring the
  // two items distinct — the source of truth. It overrides every other signal:
  // force the score to zero so the pair can never surface as a candidate.
  if (isDeclaredDifferent(a, b)) {
    reasons.unshift('marked "different from" on Wikidata (P1889), not a duplicate');
    score = 0;
  }

  // Confidence ceiling. A near-certain (≈1.0) score is reserved for pairs with a
  // very similar name AND strong, corroborated agreement — two or more shared
  // external identifiers, or an identifier plus agreeing discriminative
  // properties (developer, publisher, date, …) — and *minimal* differences. A
  // single shared identifier with a matching name is strong but not conclusive
  // (that lone id could be stale or mis-entered), so it is capped well below 1.0;
  // any concrete disagreement — a differing developer/publisher, a release-year
  // gap, or a conflicting per-title id — caps it further. Corroborating signals
  // are the shared strong ids plus the discriminative statements (non-id) that
  // agree. This clamp only ever lowers a score; it cannot make a non-duplicate
  // look like one.
  const propAgreement = stmtRows.filter(
    (r) => r.status === "identical" && !r.a.some((v) => v.type === "external-id"),
  ).length;
  const strongSignals = strongIds.length + propAgreement;
  let ceiling = 1;
  if (nameSim >= 0.75) {
    if (strongSignals >= 3) ceiling = 1;
    else if (strongSignals === 2) ceiling = 0.93;
    else if (strongSignals === 1) ceiling = 0.85;
    else ceiling = 0.72;
  }
  const hasConcreteDifference =
    diffDeveloper ||
    diffPublisher ||
    modestYearGap ||
    distinctPerTitleIds.length > 0 ||
    distinctExtIdRows.length > 0;
  if (hasConcreteDifference) ceiling = Math.min(ceiling, 0.9);
  if (distinctPerTitleIds.length === 1) ceiling = Math.min(ceiling, 0.8);
  if (score > ceiling) {
    score = ceiling;
    // Only explain the clamp when the ceiling actually held the pair *below*
    // near-certain. A ceiling of 1.0 (very similar name + 3+ corroborating
    // signals, no differences) means the pair earned the top of the range and
    // we're just clamping the raw additive sum — the ordinary `Math.min(1, …)`
    // below — so no "held back" reason applies.
    if (ceiling < 1) {
      reasons.push(
        strongSignals <= 1 && !hasConcreteDifference
          ? "held below near-certain — only one strong corroborating signal"
          : "held below near-certain — a difference remains or corroboration is thin",
      );
    }
  }

  const confidence = Math.max(0, Math.min(1, score));
  return { confidence, reasons, hasBlocker: blockers.length > 0 };
}
