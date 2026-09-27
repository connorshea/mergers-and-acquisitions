// One-off backfill of `merge_candidates.snapshot` for pairs settled because
// one side was merged away on Wikidata, before resolve-merges kept snapshots
// (see server/outside-merges.ts). Their merged-away item has left the mirror,
// so the detail page had nothing to compare. Run by
// scripts/backfill-merge-snapshots.ts.
//
// A side still in the mirror is taken from there. A side that has left is
// rebuilt from its last revision before the merge: the item's history ends in
// the merge (`wbmergeitems-to`), usually a clear (`wbeditentity-override`),
// and the redirect (`wbcreateredirect`); the revision before that run is the
// item as reviewers saw it, which Special:EntityData serves at `?revision=`.
// A deleted item has no readable history, so its pairs are left as they are.
import { and, eq, inArray, isNull, like, or } from "drizzle-orm";
import { db } from "./db.ts";
import { items, mergeCandidates } from "../db/schema.ts";
import type { Item } from "../src/lib/compare.ts";
import { type Entity, entityToItem } from "../src/lib/wikibase.ts";
import { userAgent } from "./auth/user-agent.ts";

const WIKIDATA = "https://www.wikidata.org";
/** Pause between Wikidata requests. */
const PAUSE_MS = 1000;
/** Revisions read per item, newest first; the merge edits come in 2–3. */
const REVISION_LIMIT = 10;
/** The edits a merge leaves at the end of the merged-away item's history. */
const MERGE_EDIT = /^\/\* (wbmergeitems-to|wbeditentity-override|wbcreateredirect):/;

interface Revision {
  revid: number;
  comment?: string;
}

/**
 * The item's last revision before it was merged away: the newest one that
 * isn't part of the trailing merge / clear / redirect run. Null when the
 * history doesn't end in a redirect (the item wasn't merged away) or holds
 * nothing but merge edits.
 */
export function preMergeRevid(revisions: readonly Revision[]): number | null {
  if (!revisions[0]?.comment?.startsWith("/* wbcreateredirect:")) return null;
  for (const rev of revisions) {
    if (!MERGE_EDIT.test(rev.comment ?? "")) return rev.revid;
  }
  return null;
}

export interface SnapshotBackfillStats {
  /** Settled pairs with no snapshot and a merged-elsewhere resolution. */
  candidates: number;
  /** Of those, given a snapshot (or that would be, on a dry run). */
  filled: number;
  /** Of those, left alone: a side couldn't be rebuilt. */
  skipped: number;
}

export interface SnapshotBackfillOptions {
  fetch?: typeof globalThis.fetch;
  /** Report what would be filled without writing. */
  dryRun?: boolean;
  /** Between Wikidata requests; tests pass 0. */
  pauseMs?: number;
}

/**
 * Give every settled pair whose item was merged away elsewhere, and that has
 * no snapshot, one built from the mirror and each merged-away item's last
 * revision before the merge.
 */
export async function runSnapshotBackfill(
  opts: SnapshotBackfillOptions = {},
): Promise<SnapshotBackfillStats> {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const pauseMs = opts.pauseMs ?? PAUSE_MS;
  const headers = { "User-Agent": userAgent(), Accept: "application/json" };
  let requested = false;
  async function get(url: string): Promise<unknown> {
    if (requested && pauseMs > 0) await new Promise((r) => setTimeout(r, pauseMs));
    requested = true;
    const res = await fetchImpl(url, { headers });
    if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
    return res.json();
  }

  /** The item as it was just before it was merged away, or null. */
  async function fromHistory(qid: string): Promise<Item | null> {
    const params = new URLSearchParams({
      action: "query",
      format: "json",
      formatversion: "2",
      prop: "revisions",
      titles: qid,
      rvlimit: String(REVISION_LIMIT),
      rvprop: "ids|comment",
    });
    const history = (await get(`${WIKIDATA}/w/api.php?${params}`)) as {
      query?: { pages?: { revisions?: Revision[] }[] };
    };
    const revid = preMergeRevid(history.query?.pages?.[0]?.revisions ?? []);
    if (revid === null) return null;
    const data = (await get(
      `${WIKIDATA}/wiki/Special:EntityData/${qid}.json?revision=${revid}`,
    )) as { entities?: Record<string, Entity> };
    const entity = data.entities?.[qid];
    return entity ? entityToItem(entity) : null;
  }

  const pairs = await db
    .select({
      id: mergeCandidates.id,
      fromQid: mergeCandidates.fromQid,
      intoQid: mergeCandidates.intoQid,
    })
    .from(mergeCandidates)
    .where(
      and(
        inArray(mergeCandidates.status, ["merged", "dismissed"]),
        isNull(mergeCandidates.snapshot),
        or(
          like(mergeCandidates.resolution, "% on Wikidata outside the app"),
          like(mergeCandidates.resolution, "% elsewhere"),
          like(mergeCandidates.resolution, "% became a redirect on Wikidata"),
        ),
      ),
    );
  console.log(`snapshot backfill: ${pairs.length} settled pairs without a snapshot`);

  const qids = [...new Set(pairs.flatMap((p) => [p.fromQid, p.intoQid]))];
  const known = new Map<string, Item | null>();
  if (qids.length > 0) {
    const rows = await db
      .select({ qid: items.qid, data: items.data })
      .from(items)
      .where(inArray(items.qid, qids));
    for (const r of rows) known.set(r.qid, r.data);
  }
  async function itemFor(qid: string): Promise<Item | null> {
    if (!known.has(qid)) {
      try {
        known.set(qid, await fromHistory(qid));
      } catch (err) {
        console.warn(`snapshot backfill: couldn't read ${qid}'s history`, err);
        known.set(qid, null);
      }
    }
    return known.get(qid)!;
  }

  let filled = 0;
  for (const p of pairs) {
    const from = await itemFor(p.fromQid);
    const into = await itemFor(p.intoQid);
    if (!from || !into) {
      const missing = [from ? null : p.fromQid, into ? null : p.intoQid].filter(Boolean);
      console.log(
        `snapshot backfill: #${p.id} skipped, no pre-merge copy of ${missing.join(", ")}`,
      );
      continue;
    }
    if (!opts.dryRun) {
      await db
        .update(mergeCandidates)
        .set({ snapshot: { from, into } })
        .where(and(eq(mergeCandidates.id, p.id), isNull(mergeCandidates.snapshot)));
    }
    filled++;
    console.log(`snapshot backfill: #${p.id} ${p.fromQid} / ${p.intoQid}`);
  }

  console.log(
    `snapshot backfill: ${opts.dryRun ? "would fill" : "filled"} ${filled}, ` +
      `skipped ${pairs.length - filled}`,
  );
  return { candidates: pairs.length, filled, skipped: pairs.length - filled };
}
