// Router for /api/candidates — the list, one candidate's full detail, and the
// dismiss/reopen actions. The Wikidata edit routes on the same prefix live in
// server/edits.ts; both build their responses with server/candidate-summary.ts
// so the wire shapes stay in sync.
import { Hono } from "hono";
import { and, asc, count, desc, eq, gt, gte, inArray, lt, or, sql } from "drizzle-orm";
import { db } from "./db.ts";
import { type AuthEnv, requireUser } from "./auth/session.ts";
import { addSeconds, toSqlDatetime } from "./auth/time.ts";
import { MERGING_STALE_SECONDS } from "./edits.ts";
import { loadLabels, summaryColumns, toSummary } from "./candidate-summary.ts";
import { attachSitelinkRedirects } from "./sitelink-overlay.ts";
import { loadCreations } from "./item-creations.ts";
import { cachedCount } from "./candidate-count-cache.ts";
import {
  classAncestors,
  entityLabels,
  itemCreations,
  items,
  mergeCandidates,
  properties,
} from "../db/schema.ts";
import type { Item } from "../src/lib/compare.ts";
import { chunk } from "../src/lib/chunk.ts";
import {
  itemClasses,
  makeInapplicableIdCheck,
  type SubjectTypeConstraint,
} from "../src/lib/subject-types.ts";
import { normalizeUserName } from "../src/lib/creation.ts";
import { languageSqlPatterns, normalizeLanguages } from "../src/lib/languages.ts";
import {
  CANDIDATE_SORTS,
  CANDIDATE_STATUSES,
  type CandidateCreationsResponse,
  type CandidateDetailResponse,
  type CandidateDismissResponse,
  type CandidateListResponse,
  type CandidateReopenResponse,
} from "../src/lib/api-types.ts";

const STATUSES = CANDIDATE_STATUSES;
const SORTS = CANDIDATE_SORTS;
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
/** Most instance-of types one list request filters on. */
const MAX_TYPE_FILTERS = 50;
/**
 * Longest `q` / `creator` a list request filters on; longer input is cut. A
 * Wikidata label is at most 250 characters (and a username 85), so no real
 * search loses anything, while junk can't bloat the LIKE pattern or the count
 * cache's keys.
 */
const MAX_TEXT_FILTER = 250;
// Qids/pids loaded per IN list. MariaDB has no tight bound-param cap.
const ID_CHUNK = 1000;
/** Property ids embedded in a reason string. */
const PID_RE = /\bP\d+\b/g;
/**
 * Link templates for property datatypes whose values are pages on Commons: a
 * file name for media (P18 image, P154 logo, …), a full "Data:…" page title for
 * geo shapes and tabular data. These win over the property's own formatter URL
 * (P1630) — editors have given some media properties one without the `File:`
 * namespace (P18's is ".../wiki/$1"), which links to a nonexistent page.
 */
const COMMONS_FORMATTERS: Record<string, string> = {
  CommonsMedia: "https://commons.wikimedia.org/wiki/File:$1",
  GeoShape: "https://commons.wikimedia.org/wiki/$1",
  TabularData: "https://commons.wikimedia.org/wiki/$1",
};

function parseIntParam(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export const candidates = new Hono<AuthEnv>();

// Reading is open; resolving a candidate requires a logged-in editor.
candidates.use("/:id/dismiss", requireUser);
candidates.use("/:id/reopen", requireUser);

// GET /api/candidates — paginated, filterable, sortable list.
candidates.get("/", async (c) => {
  const req = c.req;

  const q = req.query("q")?.trim().slice(0, MAX_TEXT_FILTER);
  const statusParam = req.query("status");
  const status = STATUSES.includes(statusParam as (typeof STATUSES)[number])
    ? (statusParam as (typeof STATUSES)[number])
    : "open";
  const sortParam = req.query("sort");
  const sort = SORTS.includes(sortParam as (typeof SORTS)[number])
    ? (sortParam as (typeof SORTS)[number])
    : "confidence";

  const page = Math.max(1, Math.floor(parseIntParam(req.query("page"), 1)));
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Math.floor(parseIntParam(req.query("pageSize"), DEFAULT_PAGE_SIZE))),
  );

  const conditions = [eq(mergeCandidates.status, status)];

  const minConfidenceRaw = req.query("minConfidence");
  if (minConfidenceRaw !== undefined && minConfidenceRaw !== "") {
    const minConfidence = Number(minConfidenceRaw);
    if (Number.isFinite(minConfidence)) {
      conditions.push(gte(mergeCandidates.confidence, minConfidence));
    }
  }

  // Hide pairs with a conflict that blocks the merge (the list's "Blocker"
  // flag). Off unless `noBlockers=1`.
  if (req.query("noBlockers") === "1") {
    conditions.push(eq(mergeCandidates.hasBlocker, false));
  }

  // Item-side filters, matching pairs where *either* item matches (the hunt's
  // label+type path pairs items of the same type, but the shared-id path can
  // pair across types). Both read the pair's own copies of the items'
  // primaryLabel/primaryType (see server/candidate-item-info.ts), so neither
  // has to join `items`.
  if (q) {
    // Case-insensitive substring match. The database collation is utf8mb4_bin
    // (case-sensitive), so fold both sides with lower().
    const pattern = `%${q.toLowerCase()}%`;
    conditions.push(
      or(
        sql`lower(${mergeCandidates.fromLabel}) like ${pattern}`,
        sql`lower(${mergeCandidates.intoLabel}) like ${pattern}`,
      )!,
    );
  }

  // Instance-of (P31) filter: a comma-separated list of QIDs, matching a pair
  // of any of them. Entries that aren't valid QIDs are ignored.
  const types = [
    ...new Set(
      (req.query("type") ?? "")
        .split(",")
        .map((t) => t.trim())
        .filter((t) => /^Q\d+$/.test(t)),
    ),
  ].slice(0, MAX_TYPE_FILTERS);
  if (types.length > 0) {
    conditions.push(
      or(inArray(mergeCandidates.fromType, types), inArray(mergeCandidates.intoType, types))!,
    );
  }

  // Creator filter: pairs where either item was created by this user (exact
  // match on the normalized name, via the item_creations user index). Only
  // items with an item_creations row can match; the nightly job fills those
  // for open candidates, and viewing a pair fills its two.
  const creatorParam = req.query("creator")?.trim().slice(0, MAX_TEXT_FILTER);
  if (creatorParam) {
    const createdBy = db
      .select({ qid: itemCreations.qid })
      .from(itemCreations)
      .where(eq(itemCreations.userName, normalizeUserName(creatorParam)));
    conditions.push(
      or(inArray(mergeCandidates.fromQid, createdBy), inArray(mergeCandidates.intoQid, createdBy))!,
    );
  }

  // Reader-language filter: a comma-separated list of the languages the
  // reviewer reads (the client sends the user's setting). Hides pairs with a
  // sitelink clash on a wiki in another language, or an item with no label in
  // one of them (nor `mul`). Rows the hunt hasn't annotated (null) pass.
  const langs = normalizeLanguages((req.query("lang") ?? "").split(","));
  if (langs.length > 0) {
    const { allRead, anyRead } = languageSqlPatterns(langs);
    for (const column of [mergeCandidates.fromLabelLangs, mergeCandidates.intoLabelLangs]) {
      conditions.push(sql`(${column} is null or ${column} regexp ${anyRead})`);
    }
    conditions.push(
      sql`(${mergeCandidates.clashLangs} is null or ${mergeCandidates.clashLangs} regexp ${allRead})`,
    );
  }

  const where = and(...conditions);
  const sortColumn =
    sort === "confidence" ? mergeCandidates.confidence : mergeCandidates.detectedAt;

  // Everything that decides the count (not page/pageSize/sort), normalized so
  // equivalent requests share a cache entry.
  const countKey = JSON.stringify([
    status,
    minConfidenceRaw ?? "",
    req.query("noBlockers") === "1",
    q?.toLowerCase() ?? "",
    [...types].sort(),
    creatorParam ? normalizeUserName(creatorParam) : "",
    langs,
  ]);

  // The count and the page are independent; run them concurrently (each takes
  // its own pool connection). The count is cached across pages.
  const [total, rows] = await Promise.all([
    cachedCount(countKey, async () => {
      const [{ total }] = await db.select({ total: count() }).from(mergeCandidates).where(where);
      return total;
    }),
    db
      .select(summaryColumns)
      .from(mergeCandidates)
      .where(where)
      // Always descending; id as a stable tiebreaker for deterministic paging.
      .orderBy(desc(sortColumn), desc(mergeCandidates.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
  ]);

  // Reasons embed raw property ids ("shares external identifier: P1733, …");
  // resolve the ones on this page in one batch so the list can name them.
  const pids = [
    ...new Set(
      rows.flatMap((r) =>
        Array.isArray(r.reasons) ? (r.reasons.join(" ").match(PID_RE) ?? []) : [],
      ),
    ),
  ];
  const [labels, propertyRows] = await Promise.all([
    loadLabels(rows),
    pids.length > 0
      ? db
          .select({ pid: properties.pid, label: properties.label })
          .from(properties)
          .where(inArray(properties.pid, pids))
      : [],
  ]);
  const candidateList = rows.map((r) => toSummary(r, labels));
  const propertyLabels: Record<string, string> = {};
  for (const r of propertyRows) propertyLabels[r.pid] = r.label;

  const payload: CandidateListResponse = {
    candidates: candidateList,
    total,
    page,
    pageSize,
    propertyLabels,
  };
  return c.json(payload);
});

// GET /api/candidates/:id — one candidate with both items' full data.
candidates.get("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) {
    return c.json({ error: "Invalid candidate id" }, 404);
  }

  const [found] = await db
    .select({ ...summaryColumns, snapshot: mergeCandidates.snapshot })
    .from(mergeCandidates)
    .where(eq(mergeCandidates.id, id));
  if (!found) {
    return c.json({ error: "Candidate not found" }, 404);
  }
  const { snapshot, ...row } = found;

  // Neighbours for prev/next navigation, within the same status and in the
  // list's default order: confidence desc, then id desc within a tie.
  const sameStatus = eq(mergeCandidates.status, row.status);
  const afterCurrent = or(
    lt(mergeCandidates.confidence, row.confidence),
    and(eq(mergeCandidates.confidence, row.confidence), lt(mergeCandidates.id, row.id)),
  );
  const beforeCurrent = or(
    gt(mergeCandidates.confidence, row.confidence),
    and(eq(mergeCandidates.confidence, row.confidence), gt(mergeCandidates.id, row.id)),
  );

  const [labels, itemRows, nextRows, prevRows] = await Promise.all([
    loadLabels([row]),
    // A resolved pair shows the snapshot saved when it was resolved instead.
    snapshot
      ? []
      : db
          .select({ qid: items.qid, data: items.data })
          .from(items)
          .where(inArray(items.qid, [...new Set([row.fromQid, row.intoQid])])),
    db
      .select({ id: mergeCandidates.id })
      .from(mergeCandidates)
      .where(and(sameStatus, afterCurrent))
      .orderBy(desc(mergeCandidates.confidence), desc(mergeCandidates.id))
      .limit(1),
    db
      .select({ id: mergeCandidates.id })
      .from(mergeCandidates)
      .where(and(sameStatus, beforeCurrent))
      .orderBy(asc(mergeCandidates.confidence), asc(mergeCandidates.id))
      .limit(1),
  ]);

  const dataByQid = new Map(itemRows.map((r) => [r.qid, r.data as Item]));
  const from = snapshot?.from ?? dataByQid.get(row.fromQid) ?? null;
  const into = snapshot?.into ?? dataByQid.get(row.intoQid) ?? null;

  // A candidate can outlive one of its item rows: a merge made before
  // snapshots existed dropped the merged-away item from the mirror, another
  // pair's merge or the dump prune dropped it, or it was never synced. The
  // candidate still comes back, with the missing side null, so the page can
  // say what happened instead of failing.
  if (from && into) await attachSitelinkRedirects(db, [[from, into]]);
  const present = [from, into].filter((i): i is Item => i !== null);

  // Resolve human labels for just the property ids present on this pair.
  const pids = [...new Set(present.flatMap((i) => Object.keys(i.statements)))];
  // Item-valued statements reference other Qids that need a display label too
  // (genre, platform, developer, …), as do quantity units (minute, gigabyte, …)
  // and the globes of non-Earth coordinates (Mars, …).
  // Collect them from both items' statements.
  const valueQids = new Set<string>();
  for (const item of present) {
    for (const values of Object.values(item.statements)) {
      for (const v of values) {
        if (v.type === "item" && !v.label) valueQids.add(v.value);
        if (v.unit && !v.unitLabel) valueQids.add(v.unit);
        if (v.globe && !v.globeLabel) valueQids.add(v.globe);
      }
    }
  }

  const classes = [...new Set(present.flatMap(itemClasses))];
  const [propertyChunks, valueChunks, ancestorChunks] = await Promise.all([
    Promise.all(
      chunk(pids, ID_CHUNK).map((ids) =>
        db
          .select({
            pid: properties.pid,
            label: properties.label,
            datatype: properties.datatype,
            formatterUrl: properties.formatterUrl,
            mirrorsWikidata: properties.mirrorsWikidata,
            subjectTypes: properties.subjectTypes,
          })
          .from(properties)
          .where(inArray(properties.pid, ids)),
      ),
    ),
    Promise.all(
      chunk([...valueQids], ID_CHUNK).map((ids) =>
        db
          .select({ qid: entityLabels.qid, label: entityLabels.label })
          .from(entityLabels)
          .where(inArray(entityLabels.qid, ids)),
      ),
    ),
    Promise.all(
      chunk(classes, ID_CHUNK).map((ids) =>
        db
          .select({ cls: classAncestors.class, ancestor: classAncestors.ancestor })
          .from(classAncestors)
          .where(inArray(classAncestors.class, ids)),
      ),
    ),
  ]);

  const propertyLabels: Record<string, string> = {};
  const propertyFormatters: Record<string, string> = {};
  // Properties whose ids are sourced *from* Wikidata (P31=Q24075706, the synced
  // `mirrors_wikidata` flag). The UI marks these; it unions this with the
  // hardcoded floor (isHardcodedMirrorProp) for services Wikidata hasn't tagged.
  const propertyMirrors: string[] = [];
  for (const r of propertyChunks.flat()) {
    propertyLabels[r.pid] = r.label;
    const formatter = COMMONS_FORMATTERS[r.datatype ?? ""] ?? r.formatterUrl;
    if (formatter) propertyFormatters[r.pid] = formatter;
    if (r.mirrorsWikidata) propertyMirrors.push(r.pid);
  }
  const valueLabels: Record<string, string> = {};
  for (const r of valueChunks.flat()) valueLabels[r.qid] = r.label;

  // Identifiers whose subject type constraint rules out the item carrying them
  // (a recording's ISRC on a musical work), by the same check the hunt scores
  // with. The UI marks them; skipped until class ancestors are synced, since
  // the check fails open on unknown classes anyway.
  const propertyInapplicable: Record<string, string[]> = {};
  const ancestorRows = ancestorChunks.flat();
  if (ancestorRows.length > 0) {
    const constraints = new Map<string, SubjectTypeConstraint[]>();
    for (const r of propertyChunks.flat()) {
      if (r.datatype === "ExternalId" && r.subjectTypes) constraints.set(r.pid, r.subjectTypes);
    }
    const ancestors = new Map<string, string[]>();
    for (const { cls, ancestor } of ancestorRows) {
      const list = ancestors.get(cls);
      if (list) list.push(ancestor);
      else ancestors.set(cls, [ancestor]);
    }
    const inapplicable = makeInapplicableIdCheck(constraints, ancestors);
    for (const pid of constraints.keys()) {
      const qids = present
        .filter((i) => pid in i.statements && inapplicable(pid, i))
        .map((i) => i.id);
      if (qids.length > 0) propertyInapplicable[pid] = qids;
    }
  }

  const payload: CandidateDetailResponse = {
    candidate: toSummary(row, labels),
    from,
    into,
    snapshot: snapshot != null,
    propertyLabels,
    propertyFormatters,
    propertyMirrors,
    propertyInapplicable,
    valueLabels,
    prevId: prevRows[0]?.id ?? null,
    nextId: nextRows[0]?.id ?? null,
  };
  return c.json(payload);
});

// GET /api/candidates/:id/creations — who created each item, when, and how.
// Separate from the detail so the comparison renders without waiting on the
// Action API for items the nightly replica job hasn't reached yet.
candidates.get("/:id/creations", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) {
    return c.json({ error: "Invalid candidate id" }, 404);
  }
  const [row] = await db
    .select({ fromQid: mergeCandidates.fromQid, intoQid: mergeCandidates.intoQid })
    .from(mergeCandidates)
    .where(eq(mergeCandidates.id, id));
  if (!row) {
    return c.json({ error: "Candidate not found" }, 404);
  }
  const payload: CandidateCreationsResponse = {
    creations: await loadCreations([row.fromQid, row.intoQid]),
  };
  return c.json(payload);
});

// POST /api/candidates/:id/dismiss — mark dismissed, stamp resolvedAt.
// A merged candidate stays merged (dismiss → reopen would otherwise revive a
// pair whose source item is already a redirect), and one being edited right
// now keeps its claim until it goes stale. The status check lives in the
// UPDATE itself so a concurrent merge claim can't slip in between. Dismissing
// an already-dismissed pair is a no-op that answers with it as it stands: it
// never re-stamps who resolved it (the leaderboard credits `resolvedBy`, and
// a second user's click must not take over the first one's dismissal).
candidates.post("/:id/dismiss", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) {
    return c.json({ error: "Invalid candidate id" }, 404);
  }

  const staleBefore = toSqlDatetime(addSeconds(new Date(), -MERGING_STALE_SECONDS));
  const [result] = await db
    .update(mergeCandidates)
    .set({
      status: "dismissed",
      resolvedAt: sql`CURRENT_TIMESTAMP`,
      resolvedBy: c.get("user")?.id ?? null,
    })
    .where(
      and(
        eq(mergeCandidates.id, id),
        or(
          eq(mergeCandidates.status, "open"),
          and(eq(mergeCandidates.status, "merging"), lt(mergeCandidates.resolvedAt, staleBefore)),
        ),
      ),
    );

  // MariaDB has no UPDATE … RETURNING, so re-select the summary either way.
  const [row] = await db
    .select(summaryColumns)
    .from(mergeCandidates)
    .where(eq(mergeCandidates.id, id));
  if (!row) {
    return c.json({ error: "Candidate not found" }, 404);
  }
  if (result.affectedRows === 0 && row.status !== "dismissed") {
    return c.json(
      {
        error:
          row.status === "merging"
            ? "An edit of this candidate is in progress"
            : "A merged candidate can't be dismissed",
      },
      409,
    );
  }

  const labels = await loadLabels([row]);
  const payload: CandidateDismissResponse = { candidate: toSummary(row, labels) };
  return c.json(payload);
});

// POST /api/candidates/:id/reopen — un-dismiss back to `open`, clear stamps.
// A merged candidate stays merged (the merge already happened on Wikidata and
// the merged-away item is gone from the mirror), and one that is being edited
// right now can only be reopened once its claim has gone stale.
candidates.post("/:id/reopen", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) {
    return c.json({ error: "Invalid candidate id" }, 404);
  }

  const [current] = await db
    .select({ status: mergeCandidates.status, resolvedAt: mergeCandidates.resolvedAt })
    .from(mergeCandidates)
    .where(eq(mergeCandidates.id, id));
  if (!current) {
    return c.json({ error: "Candidate not found" }, 404);
  }
  if (current.status === "merged") {
    return c.json({ error: "A merged candidate can't be reopened" }, 409);
  }
  if (
    current.status === "merging" &&
    (current.resolvedAt ?? "") >= toSqlDatetime(addSeconds(new Date(), -MERGING_STALE_SECONDS))
  ) {
    return c.json({ error: "An edit of this candidate is in progress" }, 409);
  }

  await db
    .update(mergeCandidates)
    // The snapshot described the pair when it was resolved; open, it shows live data again.
    .set({ status: "open", resolvedAt: null, resolution: null, resolvedBy: null, snapshot: null })
    .where(eq(mergeCandidates.id, id));

  const [row] = await db
    .select(summaryColumns)
    .from(mergeCandidates)
    .where(eq(mergeCandidates.id, id));
  if (!row) {
    return c.json({ error: "Candidate not found" }, 404);
  }

  const labels = await loadLabels([row]);
  const payload: CandidateReopenResponse = { candidate: toSummary(row, labels) };
  return c.json(payload);
});
