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
