// The Wikidata Action API client used for edits on a logged-in user's behalf.
// Every edit goes through `editRequest`, which:
//
//   1. loads the user's OAuth access token (refreshing it when it is about to
//      expire — see server/auth/tokens.ts);
//   2. fetches a CSRF token with `assert=user&assertuser=<name>`, so a stale or
//      swapped token fails loudly instead of editing as someone else;
//   3. POSTs the edit with our User-Agent, `formatversion=2` and
//      `errorformat=plaintext`, never `bot=1`, plus `maxlag=5` unless the
//      caller opts out (every edit this app makes today does: see
//      `INTERACTIVE`);
//   4. retries once on `badtoken` (fresh CSRF token) and once on `maxlag`
//      (after the Retry-After delay), and maps everything else to a
//      `WikidataEditError` whose `kind` the route turns into a status code.
//
// A revoked or invalid OAuth grant (`mwoauth-invalid-authorization`, a failed
// user assertion) drops the stored tokens so the user is asked to log in again.
// The network / token / clock dependencies are injectable for the unit tests;
// production callers use the defaults.
import { DEFAULT_WIKIDATA_API_URL, wikidataApiUrl } from "./auth/config.ts";
import { deleteTokens, getAccessToken, TokenError } from "./auth/tokens.ts";
import { userAgent } from "./auth/user-agent.ts";
import type { Item, MergeConflict } from "../src/lib/compare.ts";
import { entityToItem, type Entity } from "../src/lib/wikibase.ts";

/** Give up on one API request after this long; merges of big items are slow. */
export const EDIT_TIMEOUT_MS = 30_000;
/** Longest we will honour a `maxlag` Retry-After for before giving up. */
const MAX_LAG_WAIT_MS = 10_000;
const DEFAULT_LAG_WAIT_MS = 5_000;
/** Ask the API to refuse edits while replication lag exceeds this many seconds. */
const MAXLAG = "5";

export interface EditOptions {
  /**
   * Send `maxlag` (default true). The Maxlag manual lets interactive tasks —
   * a user waiting on the result — omit it; noninteractive ones must send it.
   */
  maxlag?: boolean;
}

/** An edit the user clicked and is waiting on: exempt from the lag guard. */
const INTERACTIVE: EditOptions = { maxlag: false };

export interface EditUser {
  id: number;
  username: string;
}

export type EditErrorKind =
  | "login-required"
  | "blocked"
  | "permission-denied"
  | "rate-limited"
  | "conflict"
  | "wikidata-error"
  | "network";

/**
 * A failed edit. `code` is MediaWiki's error code (or `network` / `http-<n>`)
 * and `message` its text verbatim, so the UI can show exactly what Wikidata
 * said (`permissiondenied`, `blocked`, a Wikibase conflict, …).
 */
export class WikidataEditError extends Error {
  code: string;
  kind: EditErrorKind;
  constructor(kind: EditErrorKind, code: string, message: string) {
    super(message);
    this.name = "WikidataEditError";
    this.kind = kind;
    this.code = code;
  }
}

export interface WikidataClientDeps {
  fetch: typeof globalThis.fetch;
  getAccessToken: (userId: number) => Promise<string>;
  deleteTokens: (userId: number) => Promise<void>;
  apiUrl: () => string;
  sleep: (ms: number) => Promise<void>;
}

const defaultDeps: WikidataClientDeps = {
  // Resolved per call so a test's stubbed global fetch is picked up.
  fetch: (input, init) => globalThis.fetch(input, init),
  getAccessToken,
  deleteTokens,
  apiUrl: wikidataApiUrl,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Parameters every request carries. */
const COMMON_PARAMS = { format: "json", formatversion: "2", errorformat: "plaintext" };

/** One error out of the API's `errors` (plaintext format) or legacy `error` shape. */
interface ApiError {
  code: string;
  text: string;
}

interface ApiResponse {
  status: number;
  headers: Headers;
  body: Record<string, unknown>;
}

function apiError(res: ApiResponse): ApiError | null {
  const { body } = res;
  const errors = body.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const first = errors[0] as { code?: string; text?: string; "*"?: string };
    return { code: first.code ?? "unknown", text: first.text ?? first["*"] ?? "" };
  }
  const legacy = body.error as { code?: string; info?: string } | undefined;
  if (legacy && typeof legacy === "object") {
    return { code: legacy.code ?? "unknown", text: legacy.info ?? "" };
  }
  if (res.status >= 400) {
    return {
      code: `http-${res.status}`,
      text: res.status === 429 ? "Too many requests; try again shortly" : `HTTP ${res.status}`,
    };
  }
  return null;
}

/** Codes that mean the OAuth grant no longer identifies this user. */
const AUTH_FAILURE_CODES = new Set([
  "mwoauth-invalid-authorization",
  "mwoauth-invalid-authorization-invalid-user",
  "assertuserfailed",
  "assertnameduserfailed",
]);

const MERGE_CONFLICT_TEXT = /conflict|links? to the other/i;

function kindOf(err: ApiError): EditErrorKind {
  if (AUTH_FAILURE_CODES.has(err.code)) return "login-required";
  if (err.code === "blocked" || err.code === "autoblocked") return "blocked";
  if (err.code === "permissiondenied" || err.code === "protectedpage") return "permission-denied";
  if (err.code === "ratelimited" || err.code === "http-429") return "rate-limited";
  // Wikibase reports merge conflicts as `failed-modify`: "Conflicting …" for
  // labels/descriptions/sitelinks, and "… cannot be merged because one of them
  // links to the other …" for a statement link between the pair (the
  // `statement` override). The same code also covers other save failures.
  if (err.code === "failed-modify" && MERGE_CONFLICT_TEXT.test(err.text)) return "conflict";
  if (err.code.startsWith("http-5") || err.code === "network") return "network";
  return "wikidata-error";
}

async function call(
  deps: WikidataClientDeps,
  accessToken: string,
  method: "GET" | "POST",
  params: Record<string, string>,
): Promise<ApiResponse> {
  const all = { ...COMMON_PARAMS, ...params };
  const query = new URLSearchParams(all);
  let res: Response;
  try {
    res = await deps.fetch(method === "GET" ? `${deps.apiUrl()}?${query}` : deps.apiUrl(), {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": userAgent(),
        ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
      body: method === "POST" ? query : undefined,
      signal: AbortSignal.timeout(EDIT_TIMEOUT_MS),
    });
  } catch (err) {
    throw new WikidataEditError(
      "network",
      "network",
      `Could not reach Wikidata: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, headers: res.headers, body };
}

async function loadAccessToken(user: EditUser, deps: WikidataClientDeps): Promise<string> {
  try {
    return await deps.getAccessToken(user.id);
  } catch (err) {
    if (err instanceof TokenError) {
      throw new WikidataEditError(
        "login-required",
        err.code,
        "Your Wikimedia login has expired or was revoked; log in again to edit.",
      );
    }
    throw err;
  }
}

async function fail(user: EditUser, err: ApiError, deps: WikidataClientDeps): Promise<never> {
  const kind = kindOf(err);
  if (kind === "login-required") {
    // The grant is gone (revoked on meta, or it no longer maps to this user):
    // keeping the tokens would just fail again. Log-in refreshes everything.
    await deps.deleteTokens(user.id);
    throw new WikidataEditError(
      kind,
      err.code,
      "Wikidata no longer accepts this app's authorization for your account; log in again.",
    );
  }
  throw new WikidataEditError(kind, err.code, err.text || err.code);
}

async function fetchCsrfToken(
  user: EditUser,
  accessToken: string,
  deps: WikidataClientDeps,
): Promise<string> {
  const res = await call(deps, accessToken, "GET", {
    action: "query",
    meta: "tokens",
    type: "csrf",
    assert: "user",
    assertuser: user.username,
  });
  const err = apiError(res);
  if (err) await fail(user, err, deps);
  const token = (res.body.query as { tokens?: { csrftoken?: string } } | undefined)?.tokens
    ?.csrftoken;
  // "+\\" is the anonymous token: the request was not authenticated at all.
  if (!token || token === "+\\") {
    throw new WikidataEditError("wikidata-error", "notoken", "Wikidata returned no CSRF token");
  }
  return token;
}

function retryAfterMs(headers: Headers): number {
  const seconds = Number(headers.get("retry-after"));
  const ms = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_LAG_WAIT_MS;
  return Math.min(ms, MAX_LAG_WAIT_MS);
}

/**
 * Perform one write action as `user`. `params` is the action and its own
 * parameters; the token, assertion, lag guard (unless `options.maxlag` is
 * false) and format parameters are added here. Resolves to the API's JSON body
 * on success; throws `WikidataEditError` otherwise (or whatever the DB threw
 * while loading the token).
 */
export async function editRequest(
  user: EditUser,
  params: Record<string, string>,
  deps: WikidataClientDeps = defaultDeps,
  options: EditOptions = {},
): Promise<Record<string, unknown>> {
  const accessToken = await loadAccessToken(user, deps);
  let csrf = await fetchCsrfToken(user, accessToken, deps);
  let retriedToken = false;
  let retriedLag = false;
  for (;;) {
    const res = await call(deps, accessToken, "POST", {
      ...params,
      token: csrf,
      assert: "user",
      assertuser: user.username,
      ...(options.maxlag === false ? {} : { maxlag: MAXLAG }),
    });
    const err = apiError(res);
    if (!err) return res.body;
    if (err.code === "badtoken" && !retriedToken) {
      retriedToken = true;
      csrf = await fetchCsrfToken(user, accessToken, deps);
      continue;
    }
    if (err.code === "maxlag" && !retriedLag) {
      retriedLag = true;
      await deps.sleep(retryAfterMs(res.headers));
      continue;
    }
    await fail(user, err, deps);
  }
}

export interface MergeResult {
  fromRevid: number;
  intoRevid: number;
  /**
   * Whether the source became a redirect. Wikibase only redirects the source
   * when the merge leaves it empty; anything the merge could not move stays
   * behind and keeps the item alive. For this app that is the conflicting
   * descriptions it tells the merge to ignore (`AUTO_IGNORED_CONFLICTS`) — a
   * survivor and a source with different descriptions in a shared language is
   * common — so this is often false. `finishRedirect` cleans that up rather
   * than leaving the merge half-done.
   */
  redirected: boolean;
}

/**
 * `wbmergeitems`: merge `fromQid` into `intoQid` (the app's order — the higher
 * QID into the lower). `ignoreConflicts` is sent verbatim; nothing here adds to
 * it. The caller (server/edits.ts) passes only the auto-handled kinds.
 */
export async function mergeItems(
  user: EditUser,
  opts: {
    fromQid: string;
    intoQid: string;
    ignoreConflicts: readonly MergeConflict[];
    summary: string;
  },
  deps: WikidataClientDeps = defaultDeps,
): Promise<MergeResult> {
  const params: Record<string, string> = {
    action: "wbmergeitems",
    fromid: opts.fromQid,
    toid: opts.intoQid,
    summary: opts.summary,
  };
  if (opts.ignoreConflicts.length > 0) params.ignoreconflicts = opts.ignoreConflicts.join("|");
  const body = await editRequest(user, params, deps, INTERACTIVE);
  const from = body.from as { lastrevid?: number } | undefined;
  const to = body.to as { lastrevid?: number } | undefined;
  if (typeof from?.lastrevid !== "number" || typeof to?.lastrevid !== "number") {
    throw new WikidataEditError(
      "wikidata-error",
      "unexpected-response",
      "Wikidata reported success but returned no revision ids",
    );
  }
  return {
    fromRevid: from.lastrevid,
    intoRevid: to.lastrevid,
    redirected: Boolean(body.redirected),
  };
}

/** The edit that emptied the source before it was turned into a redirect. */
export interface FinishRedirectResult {
  clearRevid: number;
}

/**
 * Finish a merge that `wbmergeitems` left half-done. Wikibase only turns the
 * source into a redirect when the merge empties it; whatever it could not move
 * stays behind and keeps the item alive — for this app the conflicting
 * descriptions it tells the merge to ignore (`AUTO_IGNORED_CONFLICTS`). This
 * makes the same two edits a human makes by hand: clear the source, then point
 * it at `intoQid` with `wbcreateredirect` (which refuses a non-empty item, so
 * the order matters). It drops that residual content, which is consistent with
 * the merge already discarding the merged-away item's descriptions.
 *
 * `baseRevid` is the merge's own revision of the source: the clear passes it as
 * `baserevid` so an edit that landed on the source between the merge and here
 * fails as a conflict rather than being silently wiped. Throws
 * `WikidataEditError` on any failure; the caller treats it as best-effort,
 * since the merge itself is already done.
 */
export async function finishRedirect(
  user: EditUser,
  opts: { fromQid: string; intoQid: string; baseRevid: number; summary: string },
  deps: WikidataClientDeps = defaultDeps,
): Promise<FinishRedirectResult> {
  const cleared = await editRequest(
    user,
    {
      action: "wbeditentity",
      id: opts.fromQid,
      baserevid: String(opts.baseRevid),
      clear: "1",
      data: "{}",
      summary: opts.summary,
    },
    deps,
    INTERACTIVE,
  );
  const clearRevid = (cleared.entity as { lastrevid?: number } | undefined)?.lastrevid;
  if (typeof clearRevid !== "number") {
    throw new WikidataEditError(
      "wikidata-error",
      "unexpected-response",
      "Wikidata cleared the item but returned no revision id",
    );
  }
  // `wbcreateredirect` answers with `{ success: 1 }` and no revision id, so
  // there is nothing more to read; `editRequest` has already thrown on any
  // API error (e.g. the item still not being empty).
  await editRequest(
    user,
    { action: "wbcreateredirect", from: opts.fromQid, to: opts.intoQid },
    deps,
    INTERACTIVE,
  );
  return { clearRevid };
}

/**
 * `wbsetsitelink` with no title: remove `qid`'s sitelink to `wiki`. Used to
 * drop a sitelink to a redirect that points at the other item's page, the one
 * sitelink clash the merge flow clears by itself (see redirectSitelinkFixes).
 */
export async function removeSitelink(
  user: EditUser,
  opts: { qid: string; wiki: string; summary: string },
  deps: WikidataClientDeps = defaultDeps,
): Promise<{ revid: number }> {
  const body = await editRequest(
    user,
    { action: "wbsetsitelink", id: opts.qid, linksite: opts.wiki, summary: opts.summary },
    deps,
    INTERACTIVE,
  );
  const revid = (body.entity as { lastrevid?: number } | undefined)?.lastrevid;
  if (typeof revid !== "number") {
    throw new WikidataEditError(
      "wikidata-error",
      "unexpected-response",
      "Wikidata removed the sitelink but returned no revision id",
    );
  }
  return { revid };
}

/**
 * `wbcreateclaim`: add an item-valued statement `qid` → `property` → `target`.
 * Used for "different from" (P1889) in each direction.
 */
export async function addItemClaim(
  user: EditUser,
  opts: { qid: string; property: string; target: string; summary: string },
  deps: WikidataClientDeps = defaultDeps,
): Promise<{ revid: number }> {
  const body = await editRequest(
    user,
    {
      action: "wbcreateclaim",
      entity: opts.qid,
      property: opts.property,
      snaktype: "value",
      value: JSON.stringify({ "entity-type": "item", id: opts.target }),
      summary: opts.summary,
    },
    deps,
    INTERACTIVE,
  );
  const revid = (body.pageinfo as { lastrevid?: number } | undefined)?.lastrevid;
  if (typeof revid !== "number") {
    throw new WikidataEditError(
      "wikidata-error",
      "unexpected-response",
      "Wikidata reported success but returned no revision id",
    );
  }
  return { revid };
}

export interface MergeProbe {
  /** Where `fromQid` redirects now, or null when it is still a real item. */
  redirectedTo: string | null;
  fromRevid: number;
  intoRevid: number;
}

/**
 * Look at whether `fromQid` has become a redirect (to `intoQid` or elsewhere)
 * and report both items' current revisions. Used after a merge request whose
 * answer never arrived — a timed-out POST may still have been applied — so the
 * outcome is checked rather than assumed. Throws `WikidataEditError` when
 * Wikidata is still unreachable or answers with an error.
 */
export async function probeMerge(
  user: EditUser,
  fromQid: string,
  intoQid: string,
  deps: WikidataClientDeps = defaultDeps,
): Promise<MergeProbe> {
  const accessToken = await loadAccessToken(user, deps);
  const info = await call(deps, accessToken, "GET", {
    action: "query",
    prop: "info",
    titles: `${fromQid}|${intoQid}`,
  });
  const infoErr = apiError(info);
  if (infoErr) await fail(user, infoErr, deps);
  const pages = (info.body.query as { pages?: unknown[] } | undefined)?.pages ?? [];
  const byTitle = new Map(
    (pages as { title?: string; lastrevid?: number; redirect?: boolean }[]).map((p) => [
      p.title,
      p,
    ]),
  );
  const from = byTitle.get(fromQid);
  const into = byTitle.get(intoQid);
  if (typeof from?.lastrevid !== "number" || typeof into?.lastrevid !== "number") {
    throw new WikidataEditError(
      "wikidata-error",
      "unexpected-response",
      `Wikidata returned no page info for ${fromQid} / ${intoQid}`,
    );
  }
  let redirectedTo: string | null = null;
  if (from.redirect) {
    // `prop=info` only flags the redirect; a second query follows it.
    const target = await call(deps, accessToken, "GET", {
      action: "query",
      titles: fromQid,
      redirects: "1",
    });
    const targetErr = apiError(target);
    if (targetErr) await fail(user, targetErr, deps);
    const redirects = (target.body.query as { redirects?: { from?: string; to?: string }[] })
      ?.redirects;
    redirectedTo = redirects?.find((r) => r.from === fromQid)?.to ?? null;
  }
  return { redirectedTo, fromRevid: from.lastrevid, intoRevid: into.lastrevid };
}

/**
 * Fetch both items' current sitelinks and statements straight from Wikidata and
 * return them as `Item`s, for re-checking merge conflicts against live data
 * rather than the possibly-stale mirror just before a merge. Only the props the
 * blocker kinds need are requested: sitelinks for the same-wiki clash, claims
 * for the "items link to each other" case. Throws `WikidataEditError` when
 * Wikidata can't be reached or answers with an error.
 */
export async function fetchItemsForMergeCheck(
  user: EditUser,
  qids: readonly [string, string],
  deps: WikidataClientDeps = defaultDeps,
): Promise<[Item, Item]> {
  const accessToken = await loadAccessToken(user, deps);
  const res = await call(deps, accessToken, "GET", {
    action: "wbgetentities",
    ids: qids.join("|"),
    props: "sitelinks|claims",
  });
  const err = apiError(res);
  if (err) await fail(user, err, deps);
  const entities = (res.body.entities as Record<string, Entity> | undefined) ?? {};
  return qids.map((qid) => {
    const entity = entities[qid];
    if (!entity) {
      throw new WikidataEditError(
        "wikidata-error",
        "unexpected-response",
        `Wikidata returned no entity data for ${qid}`,
      );
    }
    return entityToItem(entity);
  }) as [Item, Item];
}

/** A link to view revision `revid` (as a diff against its parent) on the wiki the API belongs to. */
export function revisionUrl(revid: number, apiUrl = wikidataApiUrl()): string {
  let origin: string;
  try {
    origin = new URL(apiUrl).origin;
  } catch {
    origin = new URL(DEFAULT_WIKIDATA_API_URL).origin;
  }
  return `${origin}/w/index.php?diff=prev&oldid=${revid}`;
}
