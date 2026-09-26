// Integration tests for the HTTP API (candidates list/detail/dismiss/reopen,
// API 404s) against a real MariaDB. Opt-in via DB_TEST=1 —
// see test/global-setup.ts for the database selection + migration.
import { afterAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { eq } from "drizzle-orm";
import { app } from "./app.ts";
import { db, pool } from "./db.ts";
import { refreshCandidateItemInfo } from "./candidate-item-info.ts";
import { entityLabels, itemCreations, items, mergeCandidates, properties } from "../db/schema.ts";
import type { Value } from "../src/lib/compare.ts";
import type {
  CandidateDetailResponse,
  CandidateDismissResponse,
  CandidateListResponse,
  CandidateReopenResponse,
} from "../src/lib/api-types.ts";
import {
  DB_TEST,
  insertItem,
  loginAs,
  makeItem,
  SAME_ORIGIN,
  truncateAll,
} from "../test/db-helpers.ts";

async function request<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await app.request(path, init);
  return { status: res.status, body: (await res.json()) as T };
}
const get = <T>(path: string) => request<T>(path);
/** A same-origin POST; `headers` from `loginAs()` make it an authenticated one. */
const post = <T>(path: string, headers: Record<string, string> = SAME_ORIGIN) =>
  request<T>(path, { method: "POST", headers });

const EDITOR_ID = 7;

async function list(query = ""): Promise<CandidateListResponse> {
  const { status, body } = await get<CandidateListResponse>(`/api/candidates${query}`);
  expect(status).toBe(200);
  return body;
}

async function insertCandidate(values: typeof mergeCandidates.$inferInsert): Promise<number> {
  const [{ id }] = await db.insert(mergeCandidates).values(values).$returningId();
  return id;
}

const ENGINE: Value[] = [{ type: "item", value: "Q193564", label: "game engine" }];

describe.skipIf(!DB_TEST)("candidates API", () => {
  // Three candidates: two open (0.9 and 0.5) and one dismissed whose items
  // have no `items` rows at all.
  let alpha: number; // Q20 -> Q10, 0.9, open
  let beta: number; // Q40 -> Q30, 0.5, open, blocker
  let orphan: number; // Q60 -> Q50, 0.7, dismissed, items missing

  // Session headers for a plain (non-admin) editor.
  let editor: Record<string, string>;

  beforeEach(async () => {
    await truncateAll();
    editor = await loginAs(EDITOR_ID, "Editor");
    await insertItem(
      makeItem(
        "Q10",
        "Alpha Quest",
        { P136: [{ type: "item", value: "Q744038" }] },
        { descriptions: { en: "2019 video game" } },
      ),
    );
    await insertItem(makeItem("Q20", "Alpha Quest"));
    await insertItem(makeItem("Q30", "Beta Blast", { P31: ENGINE }));
    await insertItem(makeItem("Q40", "Beta Blast", { P31: ENGINE }));

    alpha = await insertCandidate({
      fromQid: "Q20",
      intoQid: "Q10",
      confidence: 0.9,
      reasons: ["identical label"],
    });
    beta = await insertCandidate({
      fromQid: "Q40",
      intoQid: "Q30",
      confidence: 0.5,
      reasons: [],
      hasBlocker: true,
    });
    orphan = await insertCandidate({
      fromQid: "Q60",
      intoQid: "Q50",
      confidence: 0.7,
      reasons: [],
      status: "dismissed",
      resolvedAt: "2026-01-01 00:00:00",
    });
    // Copy the items' type/label onto the pairs, as the hunt's upsert would.
    await refreshCandidateItemInfo(db);

    await db.insert(properties).values([
      { pid: "P31", label: "instance of", datatype: "WikibaseItem" },
      {
        pid: "P136",
        label: "genre",
        datatype: "WikibaseItem",
        formatterUrl: "https://example.org/genre/$1",
        mirrorsWikidata: true,
      },
      { pid: "P1733", label: "Steam application ID", datatype: "ExternalId" },
    ]);
    await db.insert(entityLabels).values({ qid: "Q744038", label: "role-playing video game" });
  });

  afterAll(() => pool.end());

  describe("GET /api/candidates", () => {
    it("lists open candidates by confidence with labels resolved", async () => {
      const body = await list();
      expect(body).toMatchObject({ total: 2, page: 1, pageSize: 25 });
      expect(body.candidates.map((c) => c.id)).toEqual([alpha, beta]);
      expect(body.candidates[0]).toMatchObject({
        fromQid: "Q20",
        intoQid: "Q10",
        fromLabel: "Alpha Quest",
        intoLabel: "Alpha Quest",
        confidence: 0.9,
        status: "open",
        hasBlocker: false,
        reasons: ["identical label"],
      });
      expect(body.candidates[1].hasBlocker).toBe(true);
      // A shared type is named from the import-class presets, else entity_labels
      // (none synced for the engine class here, so its label is null).
      expect(body.candidates[0].sharedType).toEqual({ qid: "Q7889", label: "video game" });
      expect(body.candidates[1].sharedType).toEqual({ qid: "Q193564", label: null });
      expect(body.candidates[0].detectedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    });

    it("filters by status and nulls labels for items that are missing", async () => {
      const body = await list("?status=dismissed");
      expect(body.total).toBe(1);
      expect(body.candidates[0]).toMatchObject({
        id: orphan,
        fromLabel: null,
        intoLabel: null,
        sharedType: null,
        status: "dismissed",
      });
    });

    it("falls back to open for an unknown status or sort", async () => {
      const body = await list("?status=bogus&sort=bogus");
      expect(body.candidates.map((c) => c.id)).toEqual([alpha, beta]);
    });

    it("searches labels case-insensitively", async () => {
      expect((await list("?q=BETA")).candidates.map((c) => c.id)).toEqual([beta]);
      expect((await list("?q=zzz")).total).toBe(0);
    });

    it("filters by instance-of type and ignores a malformed one", async () => {
      expect((await list("?type=Q193564")).candidates.map((c) => c.id)).toEqual([beta]);
      expect((await list("?type=not-a-qid")).total).toBe(2);
    });

    it("filters by any of several comma-separated types", async () => {
      expect((await list("?type=Q193564,Q11424")).candidates.map((c) => c.id)).toEqual([beta]);
      expect((await list("?type=Q7889,Q193564")).total).toBe(2);
      // Malformed entries are dropped; the valid ones still apply.
      expect((await list("?type=bogus,Q193564,")).candidates.map((c) => c.id)).toEqual([beta]);
    });

    it("follows an item's relabel/retype once the copies are refreshed", async () => {
      await db
        .update(items)
        .set({ primaryLabel: "Gamma Grove", primaryType: "Q11424" })
        .where(eq(items.qid, "Q10"));
      // Stale until refreshed; then only the changed side moves.
      expect((await list("?q=gamma")).total).toBe(0);
      expect(await refreshCandidateItemInfo(db)).toBe(1);
      expect((await list("?q=gamma")).candidates.map((c) => c.id)).toEqual([alpha]);
      expect((await list("?type=Q11424")).candidates.map((c) => c.id)).toEqual([alpha]);
      // Q20 is still a video game, so the pair still matches that type too.
      expect((await list("?type=Q7889")).candidates.map((c) => c.id)).toEqual([alpha]);
      // The sides no longer share a type, so the pair has none to show.
      expect((await list("?type=Q7889")).candidates[0].sharedType).toBeNull();
      expect(await refreshCandidateItemInfo(db)).toBe(0);
    });

    it("filters by either item's creator", async () => {
      const created = (qid: string, userName: string | null) => ({
        qid,
        revId: Number(qid.slice(1)),
        createdAt: "2020-01-01 00:00:00",
        userName,
        tags: [],
      });
      await db.insert(itemCreations).values([
        created("Q10", "Some user"),
        created("Q20", "Other"),
        created("Q30", "Other"),
        created("Q40", null),
        created("Q50", "Some user"), // on the dismissed pair
      ]);
      expect((await list("?creator=Some user")).candidates.map((c) => c.id)).toEqual([alpha]);
      // Normalized like a MediaWiki username; still exact otherwise.
      expect((await list("?creator=some_user")).candidates.map((c) => c.id)).toEqual([alpha]);
      expect((await list("?creator=SOME USER")).total).toBe(0);
      expect((await list("?creator=Other")).candidates.map((c) => c.id)).toEqual([alpha, beta]);
      expect((await list("?creator=Other&type=Q193564")).candidates.map((c) => c.id)).toEqual([
        beta,
      ]);
      expect(
        (await list("?creator=Some user&status=dismissed")).candidates.map((c) => c.id),
      ).toEqual([orphan]);
      expect((await list("?creator=Nobody")).total).toBe(0);
      expect((await list("?creator=")).total).toBe(2);
    });

    it("applies minConfidence", async () => {
      expect((await list("?minConfidence=0.8")).candidates.map((c) => c.id)).toEqual([alpha]);
    });

    it("excludes pairs with a blocker only when noBlockers=1", async () => {
      expect((await list()).candidates.map((c) => c.id)).toEqual([alpha, beta]);
      expect((await list("?noBlockers=1")).candidates.map((c) => c.id)).toEqual([alpha]);
      expect((await list("?noBlockers=0")).total).toBe(2);
    });

    it("paginates and clamps pageSize", async () => {
      const page2 = await list("?pageSize=1&page=2");
      expect(page2).toMatchObject({ total: 2, page: 2, pageSize: 1 });
      expect(page2.candidates.map((c) => c.id)).toEqual([beta]);
      expect((await list("?pageSize=1000")).pageSize).toBe(100);
    });

    describe("language filter", () => {
      beforeEach(async () => {
        // alpha: a clash on kowiki, and an English label each side. beta: no
        // clash, but its merged-away item is labelled only in Japanese.
        await db
          .update(mergeCandidates)
          .set({ clashLangs: ",ko", fromLabelLangs: ",en", intoLabelLangs: ",en,ja" })
          .where(eq(mergeCandidates.id, alpha));
        await db
          .update(mergeCandidates)
          .set({ clashLangs: "", fromLabelLangs: ",ja", intoLabelLangs: ",en" })
          .where(eq(mergeCandidates.id, beta));
      });

      const ids = async (query: string) => (await list(query)).candidates.map((c) => c.id);

      it("hides pairs needing a language the reader doesn't read", async () => {
        expect(await ids("?lang=en")).toEqual([]);
        expect(await ids("?lang=en,ko")).toEqual([alpha]);
        // Reads the clash, but not alpha's English-only merged-away item.
        expect(await ids("?lang=ja,ko")).toEqual([]);
        expect(await ids("?lang=en,ja")).toEqual([beta]);
        expect((await list("?lang=en,ko")).total).toBe(1);
      });

      it("reads regional variants, and counts a mul label as readable", async () => {
        await db
          .update(mergeCandidates)
          .set({ fromLabelLangs: ",ja,mul", intoLabelLangs: ",en-gb" })
          .where(eq(mergeCandidates.id, beta));
        expect(await ids("?lang=en")).toEqual([beta]);
      });

      it("lets rows the hunt hasn't annotated through, and ignores junk codes", async () => {
        await db
          .update(mergeCandidates)
          .set({ clashLangs: null, fromLabelLangs: null, intoLabelLangs: null })
          .where(eq(mergeCandidates.id, alpha));
        expect(await ids("?lang=de")).toEqual([alpha]);
        expect(await ids("?lang=')%20or%201=1")).toEqual([alpha, beta]);
      });
    });
  });

  describe("GET /api/candidates/:id", () => {
    it("returns both items, lookup tables, and neighbours", async () => {
      const { status, body } = await get<CandidateDetailResponse>(`/api/candidates/${alpha}`);
      expect(status).toBe(200);
      expect(body.candidate.id).toBe(alpha);
      expect(body.from?.id).toBe("Q20");
      expect(body.into?.id).toBe("Q10");
      // Neighbours follow the list order within the same status.
      expect(body.prevId).toBeNull();
      expect(body.nextId).toBe(beta);
      // Only properties present on this pair are resolved.
      expect(body.propertyLabels).toEqual({ P31: "instance of", P136: "genre" });
      expect(body.propertyFormatters).toEqual({ P136: "https://example.org/genre/$1" });
      expect(body.propertyMirrors).toEqual(["P136"]);
      expect(body.valueLabels).toEqual({ Q744038: "role-playing video game" });
      // The synced description is backfilled onto the item.
      expect(body.into?.descriptions.en).toBe("2019 video game");
      expect(body.from?.descriptions.en).toBeUndefined();
    });

    it("links the last candidate back to the previous one", async () => {
      const { body } = await get<CandidateDetailResponse>(`/api/candidates/${beta}`);
      expect(body.prevId).toBe(alpha);
      expect(body.nextId).toBeNull();
    });

    it("404s for unknown or malformed ids", async () => {
      expect(await get("/api/candidates/999999")).toEqual({
        status: 404,
        body: { error: "Candidate not found" },
      });
      expect((await get("/api/candidates/abc")).status).toBe(404);
    });

    it("still returns a pair whose items are gone, with both sides null", async () => {
      const { status, body } = await get<CandidateDetailResponse>(`/api/candidates/${orphan}`);
      expect(status).toBe(200);
      expect(body.candidate).toMatchObject({ fromQid: "Q60", intoQid: "Q50", status: "dismissed" });
      expect(body.from).toBeNull();
      expect(body.into).toBeNull();
      expect(body.snapshot).toBe(false);
    });

    it("shows a merged pair from its snapshot, not the mirror", async () => {
      await db
        .update(mergeCandidates)
        .set({
          status: "merged",
          snapshot: {
            from: makeItem("Q20", "Alpha Quest (before)"),
            into: makeItem("Q10", "Alpha Quest", { P136: [{ type: "item", value: "Q744038" }] }),
          },
        })
        .where(eq(mergeCandidates.id, alpha));
      // The merge dropped the merged-away item from the mirror.
      await db.delete(items).where(eq(items.qid, "Q20"));
      const { status, body } = await get<CandidateDetailResponse>(`/api/candidates/${alpha}`);
      expect(status).toBe(200);
      expect(body.snapshot).toBe(true);
      expect(body.from?.labels.en).toBe("Alpha Quest (before)");
      expect(body.into?.id).toBe("Q10");
      expect(body.propertyLabels).toEqual({ P31: "instance of", P136: "genre" });
    });
  });

  describe("dismiss / reopen", () => {
    it("requires a login and a same-origin request", async () => {
      expect((await post(`/api/candidates/${alpha}/dismiss`)).status).toBe(401);
      expect((await post(`/api/candidates/${alpha}/reopen`)).status).toBe(401);
      // Logged in, but no Origin / Sec-Fetch-Site: the CSRF guard rejects it.
      const { Cookie } = editor;
      expect((await post(`/api/candidates/${alpha}/dismiss`, { Cookie })).status).toBe(403);
      const [row] = await db.select().from(mergeCandidates).where(eq(mergeCandidates.id, alpha));
      expect(row.status).toBe("open");
    });

    it("dismisses, then reopens, a candidate", async () => {
      const dismissed = await post<CandidateDismissResponse>(
        `/api/candidates/${alpha}/dismiss`,
        editor,
      );
      expect(dismissed.status).toBe(200);
      expect(dismissed.body.candidate).toMatchObject({
        id: alpha,
        status: "dismissed",
        resolvedBy: "Editor",
      });
      expect((await list()).candidates.map((c) => c.id)).toEqual([beta]);
      // The detail and the list name who resolved it too.
      const resolved = await get<CandidateDetailResponse>(`/api/candidates/${alpha}`);
      expect(resolved.body.candidate.resolvedBy).toBe("Editor");
      const dismissedList = await list("?status=dismissed");
      expect(dismissedList.candidates.find((c) => c.id === alpha)?.resolvedBy).toBe("Editor");
      // The fixture's dismissed pair was resolved without a user.
      expect(dismissedList.candidates.find((c) => c.id === orphan)?.resolvedBy).toBeNull();

      const [row] = await db.select().from(mergeCandidates).where(eq(mergeCandidates.id, alpha));
      expect(row.resolvedAt).not.toBeNull();
      // As if it had been marked "different from", which saves a snapshot.
      await db
        .update(mergeCandidates)
        .set({ snapshot: { from: makeItem("Q20", "Old"), into: makeItem("Q10", "Old") } })
        .where(eq(mergeCandidates.id, alpha));

      const reopened = await post<CandidateReopenResponse>(
        `/api/candidates/${alpha}/reopen`,
        editor,
      );
      expect(reopened.body.candidate).toMatchObject({
        id: alpha,
        status: "open",
        resolvedBy: null,
      });
      const [after] = await db.select().from(mergeCandidates).where(eq(mergeCandidates.id, alpha));
      expect(after.resolvedAt).toBeNull();
      expect(after.resolution).toBeNull();
      // Open again, it shows live data rather than the resolved-time snapshot.
      expect(after.snapshot).toBeNull();
      const detail = await get<CandidateDetailResponse>(`/api/candidates/${alpha}`);
      expect(detail.body.snapshot).toBe(false);
      expect(detail.body.from?.labels.en).toBe("Alpha Quest");
    });

    it("404s for an unknown candidate", async () => {
      expect((await post("/api/candidates/999999/dismiss", editor)).status).toBe(404);
      expect((await post("/api/candidates/999999/reopen", editor)).status).toBe(404);
    });
  });

  it("returns JSON 404s for unknown API routes", async () => {
    expect(await get("/api/nope")).toEqual({ status: 404, body: { error: "Not found" } });
    expect((await post("/api/candidates/1/nope", editor)).status).toBe(404);
  });
});
