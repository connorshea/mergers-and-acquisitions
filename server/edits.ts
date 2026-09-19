// Router for the Wikidata edits made on a logged-in user's behalf:
//
//   POST /api/candidates/:id/merge      { ignoreConflicts: [...] }
//   POST /api/candidates/:id/different
//
// Both go through server/wikidata-client.ts under the user's own OAuth grant
// (never a shared account), write a `wikidata_edits` audit row for every
// attempt, and are per-user rate limited. Wikidata enforces the user's real
// rights; the only local gate beyond a login is the profile's `blocked` flag,
// which turns a doomed edit into a clear message.
//
// The merge takes a `merging` claim on the candidate first (an optimistic
// UPDATE … WHERE status = 'open'), so a double click or a second tab can't
// both reach Wikidata. The claim's timestamp rides in `resolved_at`; a claim
// older than MERGING_STALE_SECONDS is treated as abandoned (the process died
// mid-merge) and may be taken over.
import { type Context, Hono } from "hono";
import { and, eq, inArray, lt, or } from "drizzle-orm";
import { db } from "./db.ts";
import { type AuthEnv, type AuthUser, requireUser } from "./auth/session.ts";
import { addSeconds, toSqlDatetime } from "./auth/time.ts";
import {
  externalIds,
  itemDescriptions,
  items,
  mergeCandidates,
  wikidataEdits,
} from "../db/schema.ts";
import { loadLabels, summaryColumns, toSummary } from "./candidate-summary.ts";
import { editLimiter } from "./rate-limit.ts";
import {
  addItemClaim,
  type EditErrorKind,
  mergeItems,
  revisionUrl,
  WikidataEditError,
} from "./wikidata-client.ts";
import { AUTO_IGNORED_CONFLICTS, DIFFERENT_FROM, type Item } from "../src/lib/compare.ts";
import {
  type CandidateDifferentResponse,
  type CandidateMergeResponse,
  type DifferentFromEdit,
  type EditErrorResponse,
  MERGE_CONFLICT_TYPES,
  type MergeConflictType,
} from "../src/lib/api-types.ts";

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

/** `{ ignoreConflicts?: string[] }` → the validated list, or null on a malformed body. */
function parseIgnoreConflicts(body: unknown): MergeConflictType[] | null {
  if (body === undefined || body === null) return [];
  if (typeof body !== "object") return null;
  const raw = (body as { ignoreConflicts?: unknown }).ignoreConflicts;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  const out: MergeConflictType[] = [];
  for (const v of raw) {
    if (!MERGE_CONFLICT_TYPES.includes(v as MergeConflictType)) return null;
    if (!out.includes(v as MergeConflictType)) out.push(v as MergeConflictType);
  }
  return out;
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
  return toSummary(row, await loadLabels([row.fromQid, row.intoQid]));
}

// POST /api/candidates/:id/merge — wbmergeitems fromQid → intoQid.
edits.post("/:id/merge", async (c) => {
  const user = c.get("user")!;
  const gate = editGate(c, user);
  if (gate) return gate;
  const id = parseId(c.req.param("id"));
  if (id === null) return c.json({ error: "Invalid candidate id" }, 404);

  const ignoreConflicts = parseIgnoreConflicts(await c.req.json().catch(() => null));
  if (!ignoreConflicts) {
    return errorResponse(
      c,
      { error: `ignoreConflicts must be an array of: ${MERGE_CONFLICT_TYPES.join(", ")}` },
      400,
    );
  }
  // Always ignore the auto-handled conflicts (a differing description) on top of
  // the user's explicit choices, so the user never has to resolve them by hand.
  const effectiveIgnore = [...new Set([...ignoreConflicts, ...AUTO_IGNORED_CONFLICTS])];

  // Take the claim. Only an open candidate — or one whose earlier claim went
  // stale — can be merged, and only by whoever's UPDATE lands first.
  const now = new Date();
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
  if (claim.affectedRows === 0) {
    const current = await summaryFor(id);
    if (!current) return c.json({ error: "Candidate not found" }, 404);
    return errorResponse(
      c,
      {
        error:
          current.status === "merging"
            ? "This candidate is being merged right now."
            : `This candidate is ${current.status}; only open candidates can be merged.`,
        code: "not-open",
      },
      409,
    );
  }

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
    params: { ignoreConflicts: effectiveIgnore },
  };

  let result;
  try {
    result = await mergeItems(user, {
      fromQid,
      intoQid,
      ignoreConflicts: effectiveIgnore,
      summary: `Merge duplicate items ${fromQid} → ${intoQid} — ${TOOL_CREDIT}`,
    });
  } catch (err) {
    // Give the claim back before anything else, so a failure never leaves the
    // candidate stuck in `merging`.
    await db
      .update(mergeCandidates)
      .set({ status: "open", resolvedAt: null })
      .where(and(eq(mergeCandidates.id, id), eq(mergeCandidates.status, "merging")));
    return failedEdit(c, await auditFailure(audit, err));
  }

  const stamp = toSqlDatetime(new Date());
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
        resolution: `merged into ${intoQid} (rev ${result.intoRevid})${
          result.redirected ? "" : "; source item not redirected"
        }`,
      })
      .where(eq(mergeCandidates.id, id));
    // The mirror now holds a redirect (or a stub) where fromQid was: drop its
    // rows so the hunt stops pairing it, and settle every other open candidate
    // that referenced it — those pairs no longer exist as such.
    await tx.delete(externalIds).where(eq(externalIds.qid, fromQid));
    await tx.delete(itemDescriptions).where(eq(itemDescriptions.qid, fromQid));
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

  const payload: CandidateMergeResponse = {
    candidate: (await summaryFor(id))!,
    from: { qid: fromQid, revid: result.fromRevid, url: revisionUrl(result.fromRevid) },
    into: { qid: intoQid, revid: result.intoRevid, url: revisionUrl(result.intoRevid) },
    redirected: result.redirected,
  };
  return c.json(payload);
});

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
edits.post("/:id/different", async (c) => {
  const user = c.get("user")!;
  const gate = editGate(c, user);
  if (gate) return gate;
  const id = parseId(c.req.param("id"));
  if (id === null) return c.json({ error: "Invalid candidate id" }, 404);

  const [row] = await db
    .select({
      fromQid: mergeCandidates.fromQid,
      intoQid: mergeCandidates.intoQid,
      status: mergeCandidates.status,
    })
    .from(mergeCandidates)
    .where(eq(mergeCandidates.id, id));
  if (!row) return c.json({ error: "Candidate not found" }, 404);
  if (row.status !== "open") {
    return errorResponse(
      c,
      {
        error: `This candidate is ${row.status}; only open candidates can be marked.`,
        code: "not-open",
      },
      409,
    );
  }

  const itemRows = await db
    .select({ qid: items.qid, primaryLabel: items.primaryLabel, data: items.data })
    .from(items)
    .where(inArray(items.qid, [row.fromQid, row.intoQid]));
  const byQid = new Map(itemRows.map((r) => [r.qid, r]));
  const from = byQid.get(row.fromQid);
  const into = byQid.get(row.intoQid);
  if (!from || !into) {
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
    try {
      const { revid } = await addItemClaim(user, {
        qid: item.qid,
        property: DIFFERENT_FROM,
        target: target.qid,
        summary: `Not a duplicate of ${target.qid} — ${TOOL_CREDIT}`,
      });
      await db.insert(wikidataEdits).values({ ...audit, ok: true, fromRevid: revid });
      // Reflect the new statement in the mirror so the comparison view shows it
      // and a later re-hunt sees the pair as declared different.
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
      await db.update(items).set({ data }).where(eq(items.qid, item.qid));
      results.push({
        qid: item.qid,
        target: target.qid,
        revision: { qid: item.qid, revid, url: revisionUrl(revid) },
      });
      succeeded++;
    } catch (err) {
      const known = await auditFailure(audit, err);
      if (succeeded === 0 && results.every((r) => r.skipped)) {
        // Nothing has been written on Wikidata by this request: plain failure.
        return failedEdit(c, known);
      }
      results.push({ qid: item.qid, target: target.qid, error: known.message });
    }
  }

  await db
    .update(mergeCandidates)
    .set({
      status: "dismissed",
      resolvedAt: toSqlDatetime(new Date()),
      resolvedBy: user.id,
      resolution: "marked as different from (P1889)",
    })
    .where(and(eq(mergeCandidates.id, id), eq(mergeCandidates.status, "open")));

  const payload: CandidateDifferentResponse = {
    candidate: (await summaryFor(id))!,
    edits: results,
  };
  return c.json(payload);
});
