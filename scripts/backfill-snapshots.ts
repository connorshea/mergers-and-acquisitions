// One-time backfill of `merge_candidates.snapshot` for pairs merged or marked
// "different from" through the app before snapshots were saved at edit time.
// Rebuilds both items as they were just before the edit, from Wikidata's
// revision history, so the detail view can show those pairs again.
//
// For each such pair, the edit's time is the timestamp of a revision the
// audit table says it made: the merge revision on the merged-away item, or
// the first "different from" statement. Each item's snapshot is then its last
// revision before that time, fetched from Special:EntityData (which serves old
// revisions of items that are now redirects). Not "the parent of the recorded
// revision": wbmergeitems reports the survivor's latest revision even when the
// merge didn't change it, and `created_at` is local time, not UTC.
//
// Only fills snapshots that are still null, so it is safe to re-run. Reads
// Wikidata without logging in, identified by the app's User-Agent
// (WIKIDATA_API_URL picks the wiki, as for the app).
//
//   node scripts/backfill-snapshots.ts --dry-run   # report, write nothing
//   node scripts/backfill-snapshots.ts
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db, pool } from "../server/db.ts";
import { wikidataApiUrl } from "../server/auth/config.ts";
import { userAgent } from "../server/auth/user-agent.ts";
import { mergeCandidates, wikidataEdits } from "../db/schema.ts";
import { chunk } from "../src/lib/chunk.ts";
import { type Entity, entityToItem } from "../src/lib/wikibase.ts";
import type { Item } from "../src/lib/compare.ts";

const API = wikidataApiUrl();
const ENTITY_DATA = `${new URL(API).origin}/wiki/Special:EntityData`;
const PAUSE_MS = 250; // between Wikidata requests
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function get<T>(url: string): Promise<T> {
  await sleep(PAUSE_MS);
  const res = await fetch(url, {
    headers: { "User-Agent": userAgent(), Accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

interface RevisionsResponse {
  query?: {
    pages?: {
      title: string;
      missing?: boolean;
      revisions?: { revid: number; timestamp: string }[];
    }[];
  };
}

async function query(params: Record<string, string>): Promise<RevisionsResponse> {
  const qs = new URLSearchParams({
    action: "query",
    format: "json",
    formatversion: "2",
    ...params,
  });
  return get<RevisionsResponse>(`${API}?${qs}`);
}

/** The earliest timestamp among these revisions (ISO 8601, second precision). */
async function editTime(revids: number[]): Promise<string> {
  const res = await query({ prop: "revisions", revids: revids.join("|"), rvprop: "timestamp" });
  const times = (res.query?.pages ?? []).flatMap((p) => p.revisions ?? []).map((r) => r.timestamp);
  if (times.length === 0) throw new Error(`revisions ${revids.join(", ")} not found`);
  return times.sort()[0];
}

/** `qid`'s last revision strictly before `time`. */
async function revisionBefore(qid: string, time: string): Promise<number> {
  const start = new Date(Date.parse(time) - 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const res = await query({
    prop: "revisions",
    titles: qid,
    rvlimit: "1",
    rvdir: "older",
    rvstart: start,
    rvprop: "ids|timestamp",
  });
  const rev = res.query?.pages?.[0]?.revisions?.[0];
  if (!rev) throw new Error(`${qid} has no revision before ${time}`);
  return rev.revid;
}

/** `qid` as of `revid`, in the mirror's `Item` shape. */
async function itemAt(qid: string, revid: number): Promise<Item> {
  const body = await get<{ entities?: Record<string, Entity> }>(
    `${ENTITY_DATA}/${qid}.json?revision=${revid}`,
  );
  const entity = body.entities?.[qid];
  if (!entity) throw new Error(`EntityData for ${qid} at rev ${revid} has no ${qid}`);
  return entityToItem(entity);
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  // Resolved pairs still without a snapshot, and the successful edits the app
  // made on each: a merge for `merged`, "different from" for `dismissed`
  // (a pair settled as "merged elsewhere", or dismissed without an edit, has
  // none and is left alone).
  const pending = await db
    .select({
      id: mergeCandidates.id,
      fromQid: mergeCandidates.fromQid,
      intoQid: mergeCandidates.intoQid,
      status: mergeCandidates.status,
    })
    .from(mergeCandidates)
    .where(
      and(
        isNull(mergeCandidates.snapshot),
        inArray(mergeCandidates.status, ["merged", "dismissed"]),
      ),
    );
  const revidsByCandidate = new Map<number, number[]>();
  for (const ids of chunk(
    pending.map((c) => c.id),
    500,
  )) {
    const edits = await db
      .select({
        candidateId: wikidataEdits.candidateId,
        action: wikidataEdits.action,
        fromRevid: wikidataEdits.fromRevid,
      })
      .from(wikidataEdits)
      .where(and(eq(wikidataEdits.ok, true), inArray(wikidataEdits.candidateId, ids)));
    const status = new Map(pending.map((c) => [c.id, c.status]));
    for (const e of edits) {
      if (e.candidateId === null || e.fromRevid === null) continue;
      const expected = status.get(e.candidateId) === "merged" ? "merge" : "different-from";
      if (e.action !== expected) continue;
      revidsByCandidate.set(e.candidateId, [
        ...(revidsByCandidate.get(e.candidateId) ?? []),
        e.fromRevid,
      ]);
    }
  }
  const todo = pending.filter((c) => revidsByCandidate.has(c.id));
  console.log(
    `${todo.length} pair(s) to backfill (${pending.length} resolved without a snapshot)` +
      (dryRun ? "; dry run, nothing will be written" : ""),
  );

  let filled = 0;
  let failed = 0;
  for (const c of todo) {
    const label = `#${c.id} ${c.fromQid} → ${c.intoQid} (${c.status})`;
    try {
      const time = await editTime(revidsByCandidate.get(c.id)!);
      const fromRev = await revisionBefore(c.fromQid, time);
      const intoRev = await revisionBefore(c.intoQid, time);
      const snapshot = {
        from: await itemAt(c.fromQid, fromRev),
        into: await itemAt(c.intoQid, intoRev),
      };
      if (!dryRun) {
        await db
          .update(mergeCandidates)
          .set({ snapshot })
          .where(and(eq(mergeCandidates.id, c.id), isNull(mergeCandidates.snapshot)));
      }
      filled++;
      console.log(
        `${dryRun ? "would fill" : "filled"} ${label}: edit at ${time}; ` +
          `${c.fromQid} "${snapshot.from.labels.en ?? "?"}" @${fromRev}, ` +
          `${c.intoQid} "${snapshot.into.labels.en ?? "?"}" @${intoRev}`,
      );
    } catch (err) {
      failed++;
      console.error(`skipped ${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(`done: ${filled} ${dryRun ? "would be filled" : "filled"}, ${failed} failed`);
  return failed;
}

main()
  .then(async (failed) => {
    await pool.end();
    process.exit(failed > 0 ? 1 : 0);
  })
  .catch(async (err) => {
    console.error("backfill failed", err);
    await pool.end().catch(() => {});
    process.exit(1);
  });
