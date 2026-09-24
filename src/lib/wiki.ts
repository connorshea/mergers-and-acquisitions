// App-wide base URL of the Wikidata instance the app edits (test.wikidata.org
// while developing, www.wikidata.org in production). It is derived server-side
// from WIKIDATA_API_URL and delivered to the client on the /api/auth/me
// response, then stashed here so any component can build a link to a QID,
// property, or user page without threading the base through props.
//
// A module-level holder (not an env var) because the target wiki is runtime
// config on Toolforge, not known at build time. The default keeps links working
// before /api/auth/me resolves; components that show links re-render when auth
// state lands, by which point the real value is set.
let base = "https://www.wikidata.org";

/** Set the instance base (called once from the auth response). Trailing slashes trimmed. */
export function setWikiBaseUrl(url: string): void {
  if (url) base = url.replace(/\/+$/, "");
}

/** Current instance base, e.g. "https://test.wikidata.org". */
export function wikiBaseUrl(): string {
  return base;
}

/**
 * URL of a wiki page on the edited instance. Pass the page title, already
 * namespaced where needed: a QID ("Q42"), "Property:P31", or "User:Name".
 */
export function wikiPageUrl(page: string): string {
  return `${base}/wiki/${page}`;
}

/** Sitelink site ids that don't follow the `{lang}{project}` pattern. */
const SPECIAL_SITES: Record<string, string> = {
  commonswiki: "commons.wikimedia.org",
  specieswiki: "species.wikimedia.org",
  metawiki: "meta.wikimedia.org",
  incubatorwiki: "incubator.wikimedia.org",
  outreachwiki: "outreach.wikimedia.org",
  wikimaniawiki: "wikimania.wikimedia.org",
  wikidatawiki: "www.wikidata.org",
  mediawikiwiki: "www.mediawiki.org",
  sourceswiki: "wikisource.org",
  wikifunctionswiki: "www.wikifunctions.org",
};

/** Project suffix of a `{lang}{project}` site id → the project's domain. */
const PROJECT_DOMAINS: [suffix: string, domain: string][] = [
  ["wikiquote", "wikiquote.org"],
  ["wikisource", "wikisource.org"],
  ["wikivoyage", "wikivoyage.org"],
  ["wikibooks", "wikibooks.org"],
  ["wikinews", "wikinews.org"],
  ["wikiversity", "wikiversity.org"],
  ["wiktionary", "wiktionary.org"],
  ["wiki", "wikipedia.org"],
];

/**
 * URL of a sitelink's page, e.g. ("enwiki", "Doom (1993 video game)") →
 * "https://en.wikipedia.org/wiki/Doom_(1993_video_game)". Sitelinks always point
 * at the real Wikimedia projects (the mirror comes from the production dump), so
 * this ignores the edited-instance base. Null for a site id it can't place.
 */
export function sitelinkUrl(site: string, title: string): string | null {
  let host = SPECIAL_SITES[site];
  if (!host) {
    for (const [suffix, domain] of PROJECT_DOMAINS) {
      if (!site.endsWith(suffix)) continue;
      const lang = site.slice(0, -suffix.length);
      if (/^[a-z][a-z0-9_]*$/.test(lang)) host = `${lang.replace(/_/g, "-")}.${domain}`;
      break;
    }
  }
  if (!host) return null;
  const path = encodeURIComponent(title.replace(/ /g, "_"))
    .replace(/%2F/g, "/")
    .replace(/%3A/g, ":");
  return `https://${host}/wiki/${path}`;
}
