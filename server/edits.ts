// Router for the Wikidata edits made on a logged-in user's behalf:
//
//   POST /api/candidates/:id/merge
//   POST /api/candidates/:id/different
//
// Both go through server/wikidata-client.ts under the user's own OAuth grant
// (never a shared account), write a `wikidata_edits` audit row for every
// attempt, and are per-user rate limited. Wikidata enforces the user's real
// rights; the only local gate beyond a login is the profile's `blocked` flag,
// which turns a doomed edit into a clear message.
//
// Both routes take a `merging` claim on the candidate first (an optimistic
// UPDATE … WHERE status = 'open'), so a double click or a second tab can't
// both reach Wikidata. The claim's timestamp rides in `resolved_at`; a claim
// older than MERGING_STALE_SECONDS is treated as abandoned (the process died
// mid-edit) and may be taken over.
import { type Context, Hono } from "hono";
import { and, eq, inArray, lt, or } from "drizzle-orm";
import { db } from "./db.ts";
import { type AuthEnv, type AuthUser, requireUser } from "./auth/session.ts";
import { addSeconds, toSqlDatetime } from "./auth/time.ts";
import { externalIds, items, mergeCandidates, wikidataEdits } from "../db/schema.ts";
import { loadLabels, summaryColumns, toSummary } from "./candidate-summary.ts";
import { editLimiter } from "./rate-limit.ts";
import {
  addItemClaim,
  type EditErrorKind,
  fetchItemsForMergeCheck,
  finishRedirect,
  mergeItems,
  type MergeResult,
  probeMerge,
  removeSitelink,
  revisionUrl,
  WikidataEditError,
} from "./wikidata-client.ts";
import {
  AUTO_IGNORED_CONFLICTS,
  DIFFERENT_FROM,
  type Item,
  type MergeConflict,
  mergeConflicts,
  redirectSitelinkFixes,
  type SitelinkFix,
} from "../src/lib/compare.ts";
import type {
  CandidateDifferentResponse,
  CandidateMergeResponse,
  DifferentFromEdit,
  EditErrorResponse,
  RemovedSitelink,
} from "../src/lib/api-types.ts";
import { attachLiveSitelinkRedirects } from "./live-sitelinks.ts";

/** Appended to every edit summary so the edits are traceable to this tool. */
export const TOOL_CREDIT = "M&A merge assistant";
/** A `merging` claim older than this is presumed abandoned and can be re-taken. */
export const MERGING_STALE_SECONDS = 10 * 60;

type EditContext = Context<AuthEnv>;

export const edits = new Hono<AuthEnv>();

edits.use("/:id/merge", requireUser);
edits.use("/:id/different", requireUser);

function errorResponse(
  c: EditContext,
  body: EditErrorResponse,
  status: 400 | 401 | 403 | 404 | 409 | 429 | 502,
) {
  return c.json(body, status);
}

/** The checks shared by both edit endpoints; null when the request may proceed. */
function editGate(c: EditContext, user: AuthUser): Response | null {
  if (user.blocked) {
    return errorResponse(
      c,
      {
        error: "Your Wikidata account is blocked, so this app can't edit on its behalf.",
        code: "blocked",
      },
      403,
    );
  }
  const limit = editLimiter.hit(user.id);
  if (!limit.ok) {
    c.header("Retry-After", String(limit.retryAfter));
    return errorResponse(
      c,
      {
        error: `Too many edits in a short time; try again in ${limit.retryAfter}s.`,
        code: "rate-limited",
      },
      429,
    );
  }
  return null;
}

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) ? id : null;
}

const STATUS_FOR_KIND: Record<EditErrorKind, 401 | 403 | 409 | 429 | 502> = {
  "login-required": 401,
  blocked: 403,
  "permission-denied": 403,
  "rate-limited": 429,
  conflict: 409,
  "wikidata-error": 502,
  network: 502,
};

const CODE_FOR_KIND: Record<EditErrorKind, EditErrorResponse["code"]> = {
  "login-required": "login-required",
  blocked: "blocked",
  "permission-denied": "permission-denied",
  "rate-limited": "rate-limited",
  conflict: "conflict",
  "wikidata-error": "wikidata-error",
  network: "wikidata-error",
};

interface AuditBase {
  userId: number;
  candidateId: number;
  action: "merge" | "different-from";
  fromQid: string;
  intoQid: string;
  params?: Record<string, unknown>;
}

/** Record a failed attempt; returns the error's code/text for the response. */
async function auditFailure(base: AuditBase, err: unknown): Promise<WikidataEditError> {
  const known = err instanceof WikidataEditError;
  await db.insert(wikidataEdits).values({
    ...base,
    ok: false,
    errorCode: known ? err.code : "internal",
    errorText: known ? err.message : err instanceof Error ? err.message : String(err),
  });
  if (known) return err;
  // Not a Wikidata outcome (a DB error, a bug): let Hono turn it into a 500.
  throw err;
}

/** Why the tool won't merge through each conflict kind it never overrides. */
const CONFLICT_REASON: Record<Exclude<MergeConflict, "description">, string> = {
  sitelink: "they link different pages on the same wiki",
  statement: "one item has a statement whose value is the other",
};

/** The message for a merge refused because the live items still conflict. */
function conflictMessage(
  kinds: readonly MergeConflict[],
  fromQid: string,
  intoQid: string,
): string {
  const reasons = kinds
    .filter((k): k is Exclude<MergeConflict, "description"> => k !== "description")
    .map((k) => CONFLICT_REASON[k]);
  return `Wikidata won't merge ${fromQid} into ${intoQid}: ${reasons.join("; ")}.`;
}

/** The JSON error for a failed edit, with the status its kind implies. */
function failedEdit(c: EditContext, err: WikidataEditError) {
  return errorResponse(
    c,
    { error: err.message, code: CODE_FOR_KIND[err.kind] },
    STATUS_FOR_KIND[err.kind],
  );
}

async function summaryFor(id: number) {
  const [row] = await db
    .select(summaryColumns)
    .from(mergeCandidates)
    .where(eq(mergeCandidates.id, id));
  if (!row) return null;
  return toSummary(row, await loadLabels([row]));
}

/**
 * Take the edit claim on candidate `id`: `open` → `merging`, or take over a
 * `merging` claim older than MERGING_STALE_SECONDS. Only whoever's UPDATE
 * lands first gets `true`.
 */
async function claimCandidate(id: number, now: Date): Promise<boolean> {
  const staleBefore = toSqlDatetime(addSeconds(now, -MERGING_STALE_SECONDS));
  const [claim] = await db
    .update(mergeCandidates)
    .set({ status: "merging", resolvedAt: toSqlDatetime(now) })
    .where(
      and(
        eq(mergeCandidates.id, id),
        or(
          eq(mergeCandidates.status, "open"),
          and(eq(mergeCandidates.status, "merging"), lt(mergeCandidates.resolvedAt, staleBefore)),
        ),
      ),
    );
  return claim.affectedRows > 0;
}

/** Give a claim back so a failed edit never leaves the candidate stuck in `merging`. */
async function releaseClaim(id: number): Promise<void> {
  await db
    .update(mergeCandidates)
    .set({ status: "open", resolvedAt: null })
    .where(and(eq(mergeCandidates.id, id), eq(mergeCandidates.status, "merging")));
}

/** The 404 / 409 for a claim that could not be taken; `verb` names the refused edit. */
async function claimRefused(c: EditContext, id: number, verb: string) {
  const current = await summaryFor(id);
  if (!current) return c.json({ error: "Candidate not found" }, 404);
  return errorResponse(
    c,
    {
      error:
        current.status === "merging"
          ? "This candidate is being edited right now."
          : `This candidate is ${current.status}; only open candidates can be ${verb}.`,
      code: "not-open",
    },
    409,
  );
}

// POST /api/candidates/:id/merge — wbmergeitems fromQid → intoQid.
edits.post("/:id/merge", async (c) => {
  const user = c.get("user")!;
  const gate = editGate(c, user);
  if (gate) return gate;
  const id = parseId(c.req.param("id"));
  if (id === null) return c.json({ error: "Invalid candidate id" }, 404);

  // The route takes no options. The only conflict kind ever passed to
  // `ignoreconflicts` is the auto-handled description (see
  // AUTO_IGNORED_CONFLICTS); sitelink and statement conflicts are never
  // overridden from here — Wikidata refuses the merge, and the user resolves
  // them on the items by hand first. A client still sending `ignoreConflicts`
  // gets a clear refusal rather than a merge that quietly drops its choices.
  const text = await c.req.text();
  if (text.trim() !== "") {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return errorResponse(c, { error: "Request body must be JSON" }, 400);
    }
    if (body !== null && typeof body === "object" && "ignoreConflicts" in body) {
      return errorResponse(
        c,
        {
          error:
            "Conflict overrides are not supported; resolve sitelink and statement " +
            "conflicts on Wikidata by hand, then merge.",
        },
        400,
      );
    }
  }
  const ignoreConflicts = [...AUTO_IGNORED_CONFLICTS];

  if (!(await claimCandidate(id, new Date()))) return claimRefused(c, id, "merged");

  const [row] = await db
    .select({ fromQid: mergeCandidates.fromQid, intoQid: mergeCandidates.intoQid })
    .from(mergeCandidates)
    .where(eq(mergeCandidates.id, id));
  const { fromQid, intoQid } = row;
  const audit: AuditBase = {
    userId: user.id,
    candidateId: id,
    action: "merge",
    fromQid,
    intoQid,
    params: { ignoreConflicts },
  };

  // Re-check for unresolvable conflicts against live Wikidata, not the mirror.
  // The confirm dialog's warning is computed from the last-synced data, which
  // can miss a sitelink or mutual link added since; merging through one leaves
  // the source un-redirected (a half-merge — the very thing this guards
  // against). Only the auto-handled description is ever passed to
  // `ignoreconflicts`; any real sitelink or statement conflict is refused here,
  // to be fixed by hand on the items first. The one exception is a sitelink
  // clash where one page is — per its wiki, asked just now — a redirect to the
  // other item's page: that sitelink is removed first (below), which is what
  // a human would do and loses nothing.
  let liveConflicts: MergeConflict[];
  let sitelinkFixes: SitelinkFix[] = [];
  try {
    const [freshFrom, freshInto] = await fetchItemsForMergeCheck(user, [fromQid, intoQid]);
    liveConflicts = mergeConflicts(freshFrom, freshInto).filter(
      (k) => !AUTO_IGNORED_CONFLICTS.includes(k),
    );
    if (liveConflicts.includes("sitelink")) {
      const fixes = await liveSitelinkFixes(freshFrom, freshInto);
      if (fixes) {
        sitelinkFixes = fixes;
        liveConflicts = liveConflicts.filter((k) => k !== "sitelink");
      }
    }
  } catch (err) {
    // Couldn't reach Wikidata to check: hand the claim back rather than merge
    // blind. This read touched no edit endpoint, so nothing was applied.
    await releaseClaim(id);
    return failedEdit(c, await auditFailure(audit, err));
  }
  if (liveConflicts.length > 0) {
    await releaseClaim(id);
    audit.params = { ...audit.params, blockedBy: liveConflicts };
    return failedEdit(
      c,
      await auditFailure(
        audit,
        new WikidataEditError(
          "conflict",
          "merge-conflict",
          conflictMessage(liveConflicts, fromQid, intoQid),
        ),
      ),
    );
  }

  // Remove the redirect sitelinks, only now that nothing else blocks the merge.
  // Each removal is its own edit and is recorded in the merge's audit row. If
  // one fails, stop before merging; any already removed stay removed (they
  // were redirects to the other item's page, so nothing is lost) and are named
  // in the error.
  const removedSitelinks: RemovedSitelink[] = [];
  for (const fix of sitelinkFixes) {
    const other = fix.qid === fromQid ? intoQid : fromQid;
    try {
      const { revid } = await removeSitelink(user, {
        qid: fix.qid,
        wiki: fix.wiki,
        summary:
          `Remove ${fix.wiki} sitelink "${fix.title}", a redirect to ${other}'s page ` +
          `"${fix.target}", to merge ${fromQid} → ${intoQid} (${TOOL_CREDIT})`,
      });
      removedSitelinks.push({ ...fix, revid, url: revisionUrl(revid) });
      audit.params = { ...audit.params, removedSitelinks };
    } catch (err) {
      await releaseClaim(id);
      return failedEdit(c, noteRemoved(await auditFailure(audit, err), removedSitelinks));
    }
  }

  let result: MergeResult;
  try {
    result = await mergeItems(user, {
      fromQid,
      intoQid,
      ignoreConflicts,
      summary: `Merge duplicate items ${fromQid} → ${intoQid} (${TOOL_CREDIT})`,
    });
  } catch (err) {
    // A network failure — the request timeout included — says nothing about
    // whether Wikidata applied the merge, so look before assuming it didn't.
    const outcome =
      err instanceof WikidataEditError && err.kind === "network"
        ? await mergeOutcome(user, fromQid, intoQid)
        : "not-merged";
    if (outcome === "unknown") {
      // Still unreachable: keep the claim rather than hand the candidate back
      // as `open` for a retry that would merge into a redirect. It goes stale
      // after MERGING_STALE_SECONDS, and reopen/merge are allowed again then.
      const known = await auditFailure(audit, err);
      return failedEdit(
        c,
        noteRemoved(
          new WikidataEditError(
            known.kind,
            known.code,
            `${known.message} The merge may still have gone through on Wikidata; ` +
              `this candidate stays locked for ${Math.round(MERGING_STALE_SECONDS / 60)} minutes.`,
          ),
          removedSitelinks,
        ),
      );
    }
    if (outcome === "not-merged") {
      // Give the claim back before anything else.
      await releaseClaim(id);
      return failedEdit(c, noteRemoved(await auditFailure(audit, err), removedSitelinks));
    }
    result = outcome;
    audit.params = { ...audit.params, confirmedAfterTimeout: true };
  }

  // `wbmergeitems` only redirects the source when the merge empties it; the
  // descriptions we tell it to ignore stay behind and keep it alive, so a
  // merge often lands with `redirected: false`. Finish it the way a human
  // would — clear the source, then redirect it — so the candidate doesn't need
  // hand-finishing. Best effort: the merge itself is done and recorded below,
  // so a failure here just leaves the source un-redirected (reported as before)
  // rather than failing the merge.
  if (!result.redirected) {
    try {
      await finishRedirect(user, {
        fromQid,
        intoQid,
        baseRevid: result.fromRevid,
        summary: `Redirect ${fromQid} to ${intoQid} after merge (${TOOL_CREDIT})`,
      });
      result = { ...result, redirected: true };
      audit.params = { ...audit.params, autoRedirected: true };
    } catch (err) {
      console.error(`merge: ${fromQid} → ${intoQid} merged but auto-redirect failed`, err);
    }
  }

  // The merge is done on Wikidata, so record that first — the audit row and
  // the `merged` status together, in their own short transaction — before the
  // mirror cleanup below. If the cleanup fails (a deadlock on `items` against a
  // sync job, a dropped connection) the DB still says what already happened,
  // and the candidate can't be re-taken as a stale `merging` claim and merged
  // again into a redirect.
  const stamp = toSqlDatetime(new Date());
  // The pair as the reviewer saw it, for the detail view: the cleanup below
  // drops the merged-away item and the next sync rewrites the survivor. Best
  // effort, like the cleanup: a failed read only costs the detail view.
  let snapshot: { from: Item; into: Item } | undefined;
  try {
    const mirrored = new Map(
      (
        await db
          .select({ qid: items.qid, data: items.data })
          .from(items)
          .where(inArray(items.qid, [fromQid, intoQid]))
      ).map((r) => [r.qid, r.data]),
    );
    const from = mirrored.get(fromQid);
    const into = mirrored.get(intoQid);
    if (from && into) snapshot = { from, into };
  } catch (err) {
    console.error(`merge: ${fromQid} → ${intoQid} merged but its snapshot read failed`, err);
  }
  await db.transaction(async (tx) => {
    await tx.insert(wikidataEdits).values({
      ...audit,
      ok: true,
      fromRevid: result.fromRevid,
      intoRevid: result.intoRevid,
      redirected: result.redirected,
    });
    await tx
      .update(mergeCandidates)
      .set({
        status: "merged",
        resolvedAt: stamp,
        resolvedBy: user.id,
        ...(snapshot ? { snapshot } : {}),
        resolution: `merged into ${intoQid} (rev ${result.intoRevid})${
          result.redirected ? "" : "; source item not redirected"
        }`,
      })
      .where(eq(mergeCandidates.id, id));
  });

  // The mirror now holds a redirect (or a stub) where fromQid was: drop its
  // rows so the hunt stops pairing it, and settle every other open candidate
  // that referenced it — those pairs no longer exist as such. A failure here
  // is logged rather than reported as a failed merge: the next sync drops the
  // redirect anyway, and the hunt would only re-pair it until then.
  try {
    await db.transaction(async (tx) => {
      await tx.delete(externalIds).where(eq(externalIds.qid, fromQid));
      await tx.delete(items).where(eq(items.qid, fromQid));
      await tx
        .update(mergeCandidates)
        .set({
          status: "merged",
          resolvedAt: stamp,
          resolvedBy: user.id,
          resolution: `${fromQid} merged into ${intoQid} elsewhere`,
        })
        .where(
          and(
            or(eq(mergeCandidates.fromQid, fromQid), eq(mergeCandidates.intoQid, fromQid)),
            eq(mergeCandidates.status, "open"),
          ),
        );
    });
  } catch (err) {
    console.error(`merge: ${fromQid} → ${intoQid} succeeded but the mirror cleanup failed`, err);
  }

  const payload: CandidateMergeResponse = {
    candidate: (await summaryFor(id))!,
    from: { qid: fromQid, revid: result.fromRevid, url: revisionUrl(result.fromRevid) },
    into: { qid: intoQid, revid: result.intoRevid, url: revisionUrl(result.intoRevid) },
    redirected: result.redirected,
    ...(removedSitelinks.length > 0 ? { removedSitelinks } : {}),
  };
  return c.json(payload);
});

/**
 * The sitelink clashes between the live items that the merge can clear itself
 * (see redirectSitelinkFixes), judged by asking each linked wiki now; null
 * when some clash needs a person, or when a wiki couldn't be asked — the merge
 * is then refused as a plain conflict, as before.
 */
async function liveSitelinkFixes(from: Item, into: Item): Promise<SitelinkFix[] | null> {
  try {
    await attachLiveSitelinkRedirects(from, into);
  } catch (err) {
    console.error(`merge: could not check ${from.id} / ${into.id}'s sitelinks for redirects`, err);
    return null;
  }
  return redirectSitelinkFixes(from, into);
}

/** `err`, with a note naming the redirect sitelinks already removed before it. */
function noteRemoved(err: WikidataEditError, removed: RemovedSitelink[]): WikidataEditError {
  if (removed.length === 0) return err;
  const list = removed.map((r) => `${r.qid}'s ${r.wiki} sitelink "${r.title}"`).join(", ");
  return new WikidataEditError(
    err.kind,
    err.code,
    `${err.message} (Already removed, as a redirect to the other item's page: ${list}.)`,
  );
}

/**
 * After a merge request whose answer never came: did it happen? A merged
 * source is a redirect to the target; anything else means the merge didn't
 * happen (a redirect elsewhere is someone else's merge, and the retry will get
 * Wikidata's own "is a redirect" refusal). `unknown` when the check itself
 * can't reach Wikidata either.
 */
async function mergeOutcome(
  user: AuthUser,
  fromQid: string,
  intoQid: string,
): Promise<MergeResult | "not-merged" | "unknown"> {
  let probe;
  try {
    probe = await probeMerge(user, fromQid, intoQid);
  } catch (err) {
    console.error(`merge: could not confirm the outcome of ${fromQid} → ${intoQid}`, err);
    return "unknown";
  }
  if (probe.redirectedTo !== intoQid) return "not-merged";
  return { fromRevid: probe.fromRevid, intoRevid: probe.intoRevid, redirected: true };
}

/** True when `item` already carries `different from` (P1889) → `target`. */
function hasDifferentFrom(item: Item, target: string): boolean {
  return (item.statements[DIFFERENT_FROM] ?? []).some(
    (v) => v.type === "item" && v.value === target,
  );
}

// POST /api/candidates/:id/different — wbcreateclaim P1889 in both directions,
// then dismiss the candidate. One direction is enough for Wikidata to treat the
// pair as declared distinct, so a second-leg failure still dismisses (and is
// reported per edit); a first-leg failure changes nothing and is an error.
// The same `merging` claim as the merge route keeps two submits from each
// adding their own copy of the statement (wbcreateclaim doesn't dedupe).
edits.post("/:id/different", async (c) => {
  const user = c.get("user")!;
  const gate = editGate(c, user);
  if (gate) return gate;
  const id = parseId(c.req.param("id"));
  if (id === null) return c.json({ error: "Invalid candidate id" }, 404);

  if (!(await claimCandidate(id, new Date()))) return claimRefused(c, id, "marked");

  const [row] = await db
    .select({ fromQid: mergeCandidates.fromQid, intoQid: mergeCandidates.intoQid })
    .from(mergeCandidates)
    .where(eq(mergeCandidates.id, id));
  const itemRows = await db
    .select({ qid: items.qid, primaryLabel: items.primaryLabel, data: items.data })
    .from(items)
    .where(inArray(items.qid, [row.fromQid, row.intoQid]));
  const byQid = new Map(itemRows.map((r) => [r.qid, r]));
  const from = byQid.get(row.fromQid);
  const into = byQid.get(row.intoQid);
  if (!from || !into) {
    await releaseClaim(id);
    const missing = [!from && row.fromQid, !into && row.intoQid].filter(Boolean).join(", ");
    return c.json({ error: `Item data missing for: ${missing}` }, 404);
  }

  const results: DifferentFromEdit[] = [];
  let succeeded = 0;
  for (const [item, target] of [
    [from, into],
    [into, from],
  ] as const) {
    if (hasDifferentFrom(item.data, target.qid)) {
      results.push({ qid: item.qid, target: target.qid, skipped: true });
      continue;
    }
    const audit: AuditBase = {
      userId: user.id,
      candidateId: id,
      action: "different-from",
      fromQid: item.qid,
      intoQid: target.qid,
    };
    // Only the Wikidata call decides whether this leg failed. Once the
    // statement is saved, a DB error while recording it must not be reported
    // as a failed edit: the claim would be released and a retry would add a
    // second copy of the statement (wbcreateclaim doesn't dedupe).
    let revid: number;
    try {
      ({ revid } = await addItemClaim(user, {
        qid: item.qid,
        property: DIFFERENT_FROM,
        target: target.qid,
        summary: `Not a duplicate of ${target.qid} (${TOOL_CREDIT})`,
      }));
    } catch (err) {
      if (succeeded === 0 && results.every((r) => r.skipped)) {
        // Nothing has been written on Wikidata by this request: plain failure.
        // Release first — auditFailure rethrows anything that isn't a Wikidata
        // outcome, and that must not leave the claim held.
        await releaseClaim(id);
        return failedEdit(c, await auditFailure(audit, err));
      }
      const known = await auditFailure(audit, err);
      results.push({ qid: item.qid, target: target.qid, error: known.message });
      continue;
    }
    results.push({
      qid: item.qid,
      target: target.qid,
      revision: { qid: item.qid, revid, url: revisionUrl(revid) },
    });
    succeeded++;

    try {
      await db.insert(wikidataEdits).values({ ...audit, ok: true, fromRevid: revid });
    } catch (err) {
      console.error(
        `different-from: ${item.qid} → ${target.qid} saved as rev ${revid} but the audit row failed`,
        err,
      );
    }
    // Reflect the new statement in the mirror so the comparison view shows it
    // and a later re-hunt sees the pair as declared different. The next sync
    // brings it in anyway, so a failure here is logged, not reported.
    const data: Item = {
      ...item.data,
      statements: {
        ...item.data.statements,
        [DIFFERENT_FROM]: [
          ...(item.data.statements[DIFFERENT_FROM] ?? []),
          {
            type: "item",
            value: target.qid,
            ...(target.primaryLabel ? { label: target.primaryLabel } : {}),
          },
        ],
      },
    };
    try {
      // Clear the import hash: it described the data before this edit.
      await db.update(items).set({ data, dataHash: null }).where(eq(items.qid, item.qid));
    } catch (err) {
      console.error(
        `different-from: ${item.qid} → ${target.qid} saved as rev ${revid} but the mirror update failed`,
        err,
      );
    }
  }

  await db
    .update(mergeCandidates)
    .set({
      status: "dismissed",
      resolvedAt: toSqlDatetime(new Date()),
      resolvedBy: user.id,
      // Both items as the reviewer saw them, before the statements above.
      snapshot: { from: from.data, into: into.data },
      resolution: "marked as different from (P1889)",
    })
    .where(and(eq(mergeCandidates.id, id), eq(mergeCandidates.status, "merging")));

  const payload: CandidateDifferentResponse = {
    candidate: (await summaryFor(id))!,
    edits: results,
  };
  return c.json(payload);
});
