// The reader-language filter: which languages a reviewer needs to read to judge
// a pair, and whether a user's languages cover them. Shared by the hunt (which
// stores each pair's needs on merge_candidates), the list route (which filters
// on them in SQL), and the settings page.
//
// A pair needs a reader for:
//   - every wiki where the two items link *different* pages (a sitelink clash
//     that blocks the merge): telling whether those are one subject or two
//     means reading both articles. A clash the merge clears by itself (one page
//     redirects to the other's) needs nobody.
//   - each item's name: an item with no label in the reader's languages (or
//     `mul`, the language-neutral label) can't be told apart from its partner.

import { type Item, redirectsToPartner } from "./compare.ts";
import { sitelinkLanguage } from "./wiki.ts";

/** Most languages one user can list. */
export const MAX_USER_LANGUAGES = 50;

/** A Wikidata language code: "en", "pt-br", "be-tarask", "zh-hans". */
const LANGUAGE_CODE = /^[a-z]{2,3}(-[a-z0-9]{1,8})*$/;

/**
 * Normalize user-entered language codes: trimmed, lowercased, deduplicated, in
 * input order. Entries that aren't language codes are dropped, as is `mul`
 * (always readable, so listing it means nothing).
 */
export function normalizeLanguages(input: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== "string") continue;
    const code = raw.trim().toLowerCase().replace(/_/g, "-");
    if (!LANGUAGE_CODE.test(code) || code === "mul" || out.includes(code)) continue;
    out.push(code);
    if (out.length === MAX_USER_LANGUAGES) break;
  }
  return out;
}

/** What a pair asks of its reviewer (see the top of this file). */
export interface PairLanguages {
  /** Languages of the wikis with a blocking sitelink clash, sorted. */
  clash: string[];
  /** Languages each item has a label in (including `mul`), sorted. */
  fromLabels: string[];
  intoLabels: string[];
}

export function pairLanguages(from: Item, into: Item): PairLanguages {
  const clash = new Set<string>();
  for (const [wiki, title] of Object.entries(from.sitelinks)) {
    const other = into.sitelinks[wiki];
    if (other === undefined || other === title) continue;
    if (redirectsToPartner(from, into, wiki) || redirectsToPartner(into, from, wiki)) continue;
    const lang = sitelinkLanguage(wiki);
    if (lang) clash.add(lang);
  }
  const labelLangs = (item: Item) =>
    Object.entries(item.labels)
      .filter(([, text]) => text)
      .map(([lang]) => lang)
      .sort();
  return { clash: [...clash].sort(), fromLabels: labelLangs(from), intoLabels: labelLangs(into) };
}

/**
 * Store a language list in a merge_candidates column: each code prefixed with
 * a comma (",de,es"; "" for none), the shape `languageSqlPatterns` matches.
 */
export function encodeLanguageList(langs: readonly string[]): string {
  return langs.map((l) => `,${l}`).join("");
}

/**
 * Whether a reader of `langs` reads `code`: the same code, or a regional or
 * script variant of it ("en" reads "en-gb"; "zh" reads "zh-hans").
 */
export function readsLanguage(langs: readonly string[], code: string): boolean {
  return langs.some((l) => code === l || code.startsWith(`${l}-`));
}

/**
 * Whether a reader of `langs` can review the pair: every clashing wiki is in
 * a language they read, and each item has a label they can read. The JS
 * mirror of the list route's SQL (see languageSqlPatterns).
 */
export function canReview(langs: readonly string[], pair: PairLanguages): boolean {
  const readable = (labels: string[]) => labels.some((l) => l === "mul" || readsLanguage(langs, l));
  return (
    pair.clash.every((l) => readsLanguage(langs, l)) &&
    readable(pair.fromLabels) &&
    readable(pair.intoLabels)
  );
}

/**
 * MariaDB REGEXP patterns over the encoded columns (encodeLanguageList) for a
 * reader of `langs`, which must already be normalized (normalizeLanguages), so
 * they hold only [a-z0-9-] and are safe to splice into a pattern:
 *   - `allRead`: the whole list is codes they read (a clash list they can review);
 *   - `anyRead`: some code in the list is one they read, or `mul` (a readable label).
 */
export function languageSqlPatterns(langs: readonly string[]): {
  allRead: string;
  anyRead: string;
} {
  const code = `(${langs.join("|")})(-[a-z0-9-]+)?`;
  return {
    allRead: `^(,${code})*$`,
    anyRead: `,(mul|${code})(,|$)`,
  };
}
