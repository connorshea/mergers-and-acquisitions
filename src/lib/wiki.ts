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

/** Host of a sitelink site id, e.g. "enwiki" → "en.wikipedia.org"; null if unknown. */
export function sitelinkHost(site: string): string | null {
  const special = SPECIAL_SITES[site];
  if (special) return special;
  for (const [suffix, domain] of PROJECT_DOMAINS) {
    if (!site.endsWith(suffix)) continue;
    const lang = site.slice(0, -suffix.length);
    return /^[a-z][a-z0-9_]*$/.test(lang) ? `${lang.replace(/_/g, "-")}.${domain}` : null;
  }
  return null;
}

/**
 * Wikis whose subdomain isn't the language code Wikidata labels use for the
 * same language (Simple English is English to a reader; Norwegian Wikipedia
 * is Bokmål; the rest are legacy subdomains).
 */
const SITE_LANGUAGE_ALIASES: Record<string, string> = {
  simple: "en",
  no: "nb",
  "be-x-old": "be-tarask",
  "zh-yue": "yue",
  "zh-classical": "lzh",
  "zh-min-nan": "nan",
  als: "gsw",
  "roa-rup": "rup",
  "bat-smg": "sgs",
  "fiu-vro": "vro",
};

/**
 * The language a sitelink's wiki is written in, as a Wikidata language code
 * ("eswiki" → "es", "zh_yuewiki" → "yue", "simplewiki" → "en"); null for
 * multilingual or language-less sites (Commons, Wikispecies, Wikidata, …).
 */
export function sitelinkLanguage(site: string): string | null {
  if (SPECIAL_SITES[site]) return null;
  for (const [suffix] of PROJECT_DOMAINS) {
    if (!site.endsWith(suffix)) continue;
    const prefix = site.slice(0, -suffix.length);
    if (!/^[a-z][a-z0-9_]*$/.test(prefix)) return null;
    const code = prefix.replace(/_/g, "-");
    return SITE_LANGUAGE_ALIASES[code] ?? code;
  }
  return null;
}

/**
 * URL of a sitelink's page, e.g. ("enwiki", "Doom (1993 video game)") →
 * "https://en.wikipedia.org/wiki/Doom_(1993_video_game)". Sitelinks always point
 * at the real Wikimedia projects (the mirror comes from the production dump), so
 * this ignores the edited-instance base. Null for a site id it can't place.
 */
export function sitelinkUrl(site: string, title: string): string | null {
  const host = sitelinkHost(site);
  if (!host) return null;
  const path = encodeURIComponent(title.replace(/ /g, "_"))
    .replace(/%2F/g, "/")
    .replace(/%3A/g, ":");
  return `https://${host}/wiki/${path}`;
}
