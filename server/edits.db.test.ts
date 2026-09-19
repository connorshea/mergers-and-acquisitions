// Integration tests for the Wikidata edit routes (merge, "different from") and
// the reopen guard, against a real MariaDB with the Wikidata API replaced by a
// stubbed `fetch`. Opt-in via DB_TEST=1 — see test/global-setup.ts.
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { app } from "./app.ts";
import { db, pool } from "./db.ts";
import {
  externalIds,
  items,
  mergeCandidates,
  oauthTokens,
  users,
  wikidataEdits,
} from "../db/schema.ts";
import type {
  CandidateDifferentResponse,
  CandidateMergeResponse,
  EditErrorResponse,
} from "../src/lib/api-types.ts";
import {
  DB_TEST,
  insertItem,
  loginAs,
  makeItem,
  SAME_ORIGIN,
  truncateAll,
} from "../test/db-helpers.ts";
import { storeTokens } from "./auth/tokens.ts";
import { addSeconds, toSqlDatetime } from "./auth/time.ts";
import { editLimiter } from "./rate-limit.ts";
import { MERGING_STALE_SECONDS } from "./edits.ts";

const API = "https://wd.test/w/api.php";
const ENV = {
  OAUTH_CLIENT_ID: "client-123",
  OAUTH_CLIENT_SECRET: "shh-client-secret",
  OAUTH_ISSUER: "https://oauth.test/w/rest.php/oauth2",
  BASE_URL: "http://localhost:5173",
  SESSION_SECRET: "0123456789abcdef0123456789abcdef-session",
  TOKEN_ENC_KEY: randomBytes(32).toString("base64"),
  WIKIDATA_API_URL: API,
};

const EDITOR_ID = 7;

interface Call {
  method: string;
  params: URLSearchParams;
}

/**
 * Stub the Wikidata API: the CSRF query always succeeds; each POST is answered
 * by `reply(params)`. Records every call.
 */
function stubWikidata(reply: (params: URLSearchParams, n: number) => object | Response) {
  const calls: Call[] = [];
  let posts = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith(API)) throw new Error(`unexpected fetch ${url}`);
      const method = init?.method ?? "GET";
      const params =
        method === "POST"
          ? new URLSearchParams(String(init?.body as URLSearchParams))
          : new URL(url).searchParams;
      calls.push({ method, params });
      if (method === "GET") return Response.json({ query: { tokens: { csrftoken: "csrf" } } });
      const r = reply(params, ++posts);
      return r instanceof Response ? r : Response.json(r);
    }),
  );
  return calls;
}

const mergeOk = (fromRev = 101, toRev = 102, redirected = 1) => ({
  success: 1,
  redirected,
  from: { id: "Q20", type: "item", lastrevid: fromRev },
  to: { id: "Q10", type: "item", lastrevid: toRev },
});
const claimOk = (revid: number) => ({
  success: 1,
  pageinfo: { lastrevid: revid },
  claim: { id: "x" },
});
const apiError = (code: string, text: string) => ({ errors: [{ code, text, module: "m" }] });

async function post<T>(path: string, headers: Record<string, string>, body?: unknown) {
  const res = await app.request(path, {
    method: "POST",
    headers: body === undefined ? headers : { ...headers, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, body: (await res.json()) as T };
}

const candidateRow = async (id: number) =>
  (await db.select().from(mergeCandidates).where(eq(mergeCandidates.id, id)))[0];
const itemQids = async () =>
  (await db.select({ qid: items.qid }).from(items)).map((r) => r.qid).sort();

describe.skipIf(!DB_TEST)("Wikidata edit routes", () => {
  const saved: Record<string, string | undefined> = {};
  let editor: Record<string, string>;
  let alpha: number; // Q20 -> Q10, open
  let beta: number; // Q30 -> Q20, open — references the merged-away item
  let gamma: number; // Q40 -> Q10, open — references only the survivor

  beforeAll(() => {
    for (const [k, v] of Object.entries(ENV)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
  });
  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await pool.end();
  });
  afterEach(() => vi.unstubAllGlobals());

  beforeEach(async () => {
    await truncateAll();
    editLimiter.reset();
    editor = await loginAs(EDITOR_ID, "Alice");
    await storeTokens(EDITOR_ID, {
      access_token: "access",
      refresh_token: "refresh",
      expires_in: 3600,
    });
    await insertItem(
      makeItem("Q10", "Alpha Quest", { P136: [{ type: "item", value: "Q744038" }] }),
    );
    await insertItem(
      makeItem("Q20", "Alpha Quest", { P1733: [{ type: "external-id", value: "440" }] }),
    );
    await insertItem(makeItem("Q30", "Alpha Quest"));
    await insertItem(makeItem("Q40", "Alpha Quest"));
    const insert = async (fromQid: string, intoQid: string) =>
      (
        await db
          .insert(mergeCandidates)
          .values({ fromQid, intoQid, confidence: 0.9, reasons: ["identical label"] })
          .$returningId()
      )[0].id;
    alpha = await insert("Q20", "Q10");
    beta = await insert("Q30", "Q20");
    gamma = await insert("Q40", "Q10");
  });

  describe("POST /api/candidates/:id/merge", () => {
    it("requires a login and a same-origin request", async () => {
      expect((await post(`/api/candidates/${alpha}/merge`, SAME_ORIGIN)).status).toBe(401);
      expect((await post(`/api/candidates/${alpha}/merge`, { Cookie: editor.Cookie })).status).toBe(
        403,
      );
      expect((await candidateRow(alpha)).status).toBe("open");
    });

    it("refuses a blocked account before touching Wikidata", async () => {
      await db.update(users).set({ blocked: true }).where(eq(users.id, EDITOR_ID));
      const calls = stubWikidata(() => mergeOk());
      const { status, body } = await post<EditErrorResponse>(
        `/api/candidates/${alpha}/merge`,
        editor,
      );
      expect(status).toBe(403);
      expect(body.code).toBe("blocked");
      expect(calls).toHaveLength(0);
      expect((await candidateRow(alpha)).status).toBe("open");
    });

    it("rejects a malformed ignoreConflicts", async () => {
      const { status } = await post(`/api/candidates/${alpha}/merge`, editor, {
        ignoreConflicts: ["bogus"],
      });
      expect(status).toBe(400);
      expect((await candidateRow(alpha)).status).toBe("open");
    });

    it("rejects a body that is not JSON instead of merging without overrides", async () => {
      stubWikidata(() => mergeOk(101, 102));
      const res = await app.request(`/api/candidates/${alpha}/merge`, {
        method: "POST",
        headers: { ...editor, "Content-Type": "application/json" },
        body: '{"ignoreConflicts": ["sitelink"]',
      });
      expect(res.status).toBe(400);
      expect((await candidateRow(alpha)).status).toBe("open");
      expect(await db.select().from(wikidataEdits)).toEqual([]);
    });

    it("merges, records the revisions, and settles the mirror", async () => {
      const calls = stubWikidata(() => mergeOk(101, 102));
      const { status, body } = await post<CandidateMergeResponse>(
        `/api/candidates/${alpha}/merge`,
        editor,
        {
          ignoreConflicts: ["description"],
        },
      );
      expect(status).toBe(200);
      expect(body.candidate).toMatchObject({
        id: alpha,
        status: "merged",
        resolution: "merged into Q10 (rev 102)",
      });
      expect(body.from).toEqual({
        qid: "Q20",
        revid: 101,
        url: "https://wd.test/w/index.php?diff=prev&oldid=101",
      });
      expect(body.into).toEqual({
        qid: "Q10",
        revid: 102,
        url: "https://wd.test/w/index.php?diff=prev&oldid=102",
      });
      expect(body.redirected).toBe(true);

      // The edit went out as this user, with the guards, in the app's order.
      const edit = calls.find((c) => c.method === "POST")!;
      expect(Object.fromEntries(edit.params)).toMatchObject({
        action: "wbmergeitems",
        fromid: "Q20",
        toid: "Q10",
        ignoreconflicts: "description",
        assertuser: "Alice",
        maxlag: "5",
        token: "csrf",
      });
      expect(edit.params.get("summary")).toContain("M&A merge assistant");
      expect(edit.params.get("summary")!.length).toBeLessThan(260);
      expect(edit.params.has("bot")).toBe(false);

      const row = await candidateRow(alpha);
      expect(row.status).toBe("merged");
      expect(row.resolvedBy).toBe(EDITOR_ID);
      expect(row.resolvedAt).not.toBeNull();

      // The merged-away item is gone from the mirror, ids included.
      expect(await itemQids()).toEqual(["Q10", "Q30", "Q40"]);
      expect(await db.select().from(externalIds).where(eq(externalIds.qid, "Q20"))).toEqual([]);
      // Candidates that referenced it are settled; ones on the survivor stay open.
      expect(await candidateRow(beta)).toMatchObject({
        status: "merged",
        resolution: "Q20 merged into Q10 elsewhere",
        resolvedBy: EDITOR_ID,
      });
      expect((await candidateRow(gamma)).status).toBe("open");

      const audits = await db.select().from(wikidataEdits);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        userId: EDITOR_ID,
        candidateId: alpha,
        action: "merge",
        fromQid: "Q20",
        intoQid: "Q10",
        params: { ignoreConflicts: ["description"] },
        ok: true,
        fromRevid: 101,
        intoRevid: 102,
        redirected: true,
      });
    });

    it("notes when the source item was not redirected", async () => {
      stubWikidata(() => mergeOk(101, 102, 0));
      const { body } = await post<CandidateMergeResponse>(
        `/api/candidates/${alpha}/merge`,
        editor,
        {
          ignoreConflicts: ["sitelink"],
        },
      );
      expect(body.redirected).toBe(false);
      expect(body.candidate.resolution).toBe(
        "merged into Q10 (rev 102); source item not redirected",
      );
    });

    it("reverts to open and audits the failure when Wikidata refuses", async () => {
      stubWikidata(() => apiError("failed-modify", "Conflicting descriptions for language en"));
      const { status, body } = await post<EditErrorResponse>(
        `/api/candidates/${alpha}/merge`,
        editor,
        {},
      );
      expect(status).toBe(409);
      expect(body).toEqual({ error: "Conflicting descriptions for language en", code: "conflict" });

      const row = await candidateRow(alpha);
      expect(row.status).toBe("open");
      expect(row.resolvedAt).toBeNull();
      expect(await itemQids()).toEqual(["Q10", "Q20", "Q30", "Q40"]);
      expect((await candidateRow(beta)).status).toBe("open");

      const [audit] = await db.select().from(wikidataEdits);
      expect(audit).toMatchObject({
        action: "merge",
        ok: false,
        errorCode: "failed-modify",
        errorText: "Conflicting descriptions for language en",
        fromRevid: null,
      });
    });

    it("maps a revoked grant to a re-login and drops the stored tokens", async () => {
      stubWikidata(() =>
        apiError(
          "mwoauth-invalid-authorization",
          "The authorization headers in your request are not valid",
        ),
      );
      // The stub also answers the CSRF query with a token, so the failure lands on the edit.
      const { status, body } = await post<EditErrorResponse>(
        `/api/candidates/${alpha}/merge`,
        editor,
        {},
      );
      expect(status).toBe(401);
      expect(body.code).toBe("login-required");
      expect(await db.select().from(oauthTokens).where(eq(oauthTokens.userId, EDITOR_ID))).toEqual(
        [],
      );
      expect((await candidateRow(alpha)).status).toBe("open");
    });

    it("refuses a candidate that is not open, including one mid-merge, unless the claim is stale", async () => {
      const calls = stubWikidata(() => mergeOk());
      await db
        .update(mergeCandidates)
        .set({ status: "dismissed", resolvedAt: toSqlDatetime(new Date()) })
        .where(eq(mergeCandidates.id, gamma));
      const dismissed = await post<EditErrorResponse>(`/api/candidates/${gamma}/merge`, editor, {});
      expect(dismissed.status).toBe(409);
      expect(dismissed.body.code).toBe("not-open");

      await db
        .update(mergeCandidates)
        .set({ status: "merging", resolvedAt: toSqlDatetime(new Date()) })
        .where(eq(mergeCandidates.id, alpha));
      const busy = await post<EditErrorResponse>(`/api/candidates/${alpha}/merge`, editor, {});
      expect(busy.status).toBe(409);
      expect(busy.body.error).toMatch(/being edited/);
      expect(calls).toHaveLength(0);

      await db
        .update(mergeCandidates)
        .set({ resolvedAt: toSqlDatetime(addSeconds(new Date(), -MERGING_STALE_SECONDS - 60)) })
        .where(eq(mergeCandidates.id, alpha));
      const retaken = await post<CandidateMergeResponse>(
        `/api/candidates/${alpha}/merge`,
        editor,
        {},
      );
      expect(retaken.status).toBe(200);
      expect(retaken.body.candidate.status).toBe("merged");

      expect((await post(`/api/candidates/999999/merge`, editor, {})).status).toBe(404);
    });

    it("rate limits a burst of edits per user", async () => {
      stubWikidata(() => mergeOk());
      for (let i = 0; i < 10; i++) editLimiter.hit(EDITOR_ID);
      const { status, headers, body } = await post<EditErrorResponse>(
        `/api/candidates/${alpha}/merge`,
        editor,
        {},
      );
      expect(status).toBe(429);
      expect(body.code).toBe("rate-limited");
      expect(Number(headers.get("Retry-After"))).toBeGreaterThan(0);
      expect((await candidateRow(alpha)).status).toBe("open");
    });
  });

  describe("POST /api/candidates/:id/different", () => {
    it("adds P1889 both ways, mirrors it, and dismisses", async () => {
      const calls = stubWikidata((_p, n) => claimOk(200 + n));
      const { status, body } = await post<CandidateDifferentResponse>(
        `/api/candidates/${alpha}/different`,
        editor,
      );
      expect(status).toBe(200);
      expect(body.candidate).toMatchObject({
        id: alpha,
        status: "dismissed",
        resolution: "marked as different from (P1889)",
      });
      expect(body.edits).toEqual([
        {
          qid: "Q20",
          target: "Q10",
          revision: {
            qid: "Q20",
            revid: 201,
            url: "https://wd.test/w/index.php?diff=prev&oldid=201",
          },
        },
        {
          qid: "Q10",
          target: "Q20",
          revision: {
            qid: "Q10",
            revid: 202,
            url: "https://wd.test/w/index.php?diff=prev&oldid=202",
          },
        },
      ]);

      const posts = calls
        .filter((c) => c.method === "POST")
        .map((c) => Object.fromEntries(c.params));
      expect(posts).toHaveLength(2);
      expect(posts[0]).toMatchObject({
        action: "wbcreateclaim",
        entity: "Q20",
        property: "P1889",
        snaktype: "value",
        value: JSON.stringify({ "entity-type": "item", id: "Q10" }),
        assertuser: "Alice",
      });
      expect(posts[1]).toMatchObject({
        entity: "Q10",
        value: JSON.stringify({ "entity-type": "item", id: "Q20" }),
      });

      // The mirror carries the new statements (with the target's label).
      const rows = await db.select({ qid: items.qid, data: items.data }).from(items);
      const byQid = new Map(rows.map((r) => [r.qid, r.data]));
      expect(byQid.get("Q20")!.statements.P1889).toEqual([
        { type: "item", value: "Q10", label: "Alpha Quest" },
      ]);
      expect(byQid.get("Q10")!.statements.P1889).toEqual([
        { type: "item", value: "Q20", label: "Alpha Quest" },
      ]);
      // Other statements are untouched.
      expect(byQid.get("Q10")!.statements.P136).toEqual([{ type: "item", value: "Q744038" }]);

      expect((await candidateRow(alpha)).resolvedBy).toBe(EDITOR_ID);
      const audits = await db.select().from(wikidataEdits);
      expect(audits.map((a) => [a.action, a.fromQid, a.intoQid, a.ok, a.fromRevid])).toEqual([
        ["different-from", "Q20", "Q10", true, 201],
        ["different-from", "Q10", "Q20", true, 202],
      ]);
    });

    it("skips a direction the mirror already has", async () => {
      const [q20] = await db.select({ data: items.data }).from(items).where(eq(items.qid, "Q20"));
      await db
        .update(items)
        .set({
          data: {
            ...q20.data,
            statements: { ...q20.data.statements, P1889: [{ type: "item", value: "Q10" }] },
          },
        })
        .where(eq(items.qid, "Q20"));
      const calls = stubWikidata(() => claimOk(300));
      const { body } = await post<CandidateDifferentResponse>(
        `/api/candidates/${alpha}/different`,
        editor,
      );
      expect(body.edits).toEqual([
        { qid: "Q20", target: "Q10", skipped: true },
        {
          qid: "Q10",
          target: "Q20",
          revision: {
            qid: "Q10",
            revid: 300,
            url: "https://wd.test/w/index.php?diff=prev&oldid=300",
          },
        },
      ]);
      expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
      expect(body.candidate.status).toBe("dismissed");
    });

    it("changes nothing when the first claim fails, but dismisses after a second-leg failure", async () => {
      stubWikidata(() => apiError("permissiondenied", "You do not have permission to edit"));
      const first = await post<EditErrorResponse>(`/api/candidates/${alpha}/different`, editor);
      expect(first.status).toBe(403);
      expect(first.body).toEqual({
        error: "You do not have permission to edit",
        code: "permission-denied",
      });
      expect((await candidateRow(alpha)).status).toBe("open");
      expect((await db.select().from(wikidataEdits)).map((a) => a.ok)).toEqual([false]);
      vi.unstubAllGlobals();

      stubWikidata((_p, n) => (n === 1 ? claimOk(500) : apiError("ratelimited", "Too fast")));
      const second = await post<CandidateDifferentResponse>(
        `/api/candidates/${alpha}/different`,
        editor,
      );
      expect(second.status).toBe(200);
      expect(second.body.candidate.status).toBe("dismissed");
      expect(second.body.edits[0].revision?.revid).toBe(500);
      expect(second.body.edits[1]).toEqual({ qid: "Q10", target: "Q20", error: "Too fast" });
    });

    it("takes the claim, so concurrent submits add the statements only once", async () => {
      const calls = stubWikidata((_p, n) => claimOk(200 + n));
      const [a, b] = await Promise.all([
        post<CandidateDifferentResponse | EditErrorResponse>(
          `/api/candidates/${alpha}/different`,
          editor,
        ),
        post<CandidateDifferentResponse | EditErrorResponse>(
          `/api/candidates/${alpha}/different`,
          editor,
        ),
      ]);
      expect([a.status, b.status].sort((x, y) => x - y)).toEqual([200, 409]);
      const refused = (a.status === 409 ? a : b).body as EditErrorResponse;
      expect(refused.code).toBe("not-open");
      // One claim per direction, no duplicates.
      expect(calls.filter((x) => x.method === "POST")).toHaveLength(2);
      expect((await db.select().from(wikidataEdits)).filter((e) => e.ok)).toHaveLength(2);
      expect((await candidateRow(alpha)).status).toBe("dismissed");

      // A claim someone else holds is refused outright…
      await db
        .update(mergeCandidates)
        .set({ status: "merging", resolvedAt: toSqlDatetime(new Date()) })
        .where(eq(mergeCandidates.id, beta));
      const busy = await post<EditErrorResponse>(`/api/candidates/${beta}/different`, editor);
      expect(busy.status).toBe(409);
      expect(busy.body.error).toMatch(/being edited/);
      expect(calls.filter((x) => x.method === "POST")).toHaveLength(2);
    });

    it("refuses a non-open candidate and an unknown one", async () => {
      stubWikidata(() => claimOk(1));
      await db
        .update(mergeCandidates)
        .set({ status: "merged" })
        .where(eq(mergeCandidates.id, alpha));
      const { status, body } = await post<EditErrorResponse>(
        `/api/candidates/${alpha}/different`,
        editor,
      );
      expect(status).toBe(409);
      expect(body.code).toBe("not-open");
      expect((await post(`/api/candidates/999999/different`, editor)).status).toBe(404);
    });
  });

  describe("POST /api/candidates/:id/merge when the request times out", () => {
    /**
     * Stub where the merge POST never answers (the fetch rejects like an
     * aborted request) and the follow-up GETs come from `probe`.
     */
    function stubTimedOutMerge(probe: (params: URLSearchParams) => object | Error) {
      const calls: Call[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async (input, init) => {
          const url = String(input instanceof Request ? input.url : input);
          const method = init?.method ?? "GET";
          const params =
            method === "POST"
              ? new URLSearchParams(String(init?.body as URLSearchParams))
              : new URL(url).searchParams;
          calls.push({ method, params });
          if (method === "POST") throw new DOMException("The operation timed out", "TimeoutError");
          if (params.get("meta") === "tokens") {
            return Response.json({ query: { tokens: { csrftoken: "csrf" } } });
          }
          const r = probe(params);
          if (r instanceof Error) throw r;
          return Response.json(r);
        }),
      );
      return calls;
    }
    const pageInfo = (fromRedirect: boolean) => ({
      query: {
        pages: [
          { title: "Q20", lastrevid: 601, ...(fromRedirect ? { redirect: true } : {}) },
          { title: "Q10", lastrevid: 602 },
        ],
      },
    });

    it("settles the merge when Wikidata turns out to have applied it", async () => {
      stubTimedOutMerge((p) =>
        p.get("redirects")
          ? { query: { redirects: [{ from: "Q20", to: "Q10" }] } }
          : pageInfo(true),
      );
      const { status, body } = await post<CandidateMergeResponse>(
        `/api/candidates/${alpha}/merge`,
        editor,
        {},
      );
      expect(status).toBe(200);
      expect(body.candidate).toMatchObject({ id: alpha, status: "merged" });
      expect(body.from).toMatchObject({ qid: "Q20", revid: 601 });
      expect(body.into).toMatchObject({ qid: "Q10", revid: 602 });
      expect(body.redirected).toBe(true);
      expect(await itemQids()).toEqual(["Q10", "Q30", "Q40"]);
      const [audit] = await db.select().from(wikidataEdits);
      expect(audit).toMatchObject({
        ok: true,
        fromRevid: 601,
        intoRevid: 602,
        params: { ignoreConflicts: ["description"], confirmedAfterTimeout: true },
      });
    });

    it("reverts to open when the merge turns out not to have happened", async () => {
      stubTimedOutMerge(() => pageInfo(false));
      const { status, body } = await post<EditErrorResponse>(
        `/api/candidates/${alpha}/merge`,
        editor,
        {},
      );
      expect(status).toBe(502);
      expect(body.code).toBe("wikidata-error");
      expect((await candidateRow(alpha)).status).toBe("open");
      expect(await itemQids()).toEqual(["Q10", "Q20", "Q30", "Q40"]);
      const [audit] = await db.select().from(wikidataEdits);
      expect(audit).toMatchObject({ ok: false, errorCode: "network" });
    });

    it("keeps the claim when the outcome can't be checked either", async () => {
      stubTimedOutMerge(() => new TypeError("fetch failed"));
      const { status, body } = await post<EditErrorResponse>(
        `/api/candidates/${alpha}/merge`,
        editor,
        {},
      );
      expect(status).toBe(502);
      expect(body.error).toMatch(/may still have gone through/);
      const row = await candidateRow(alpha);
      expect(row.status).toBe("merging");
      expect(row.resolvedAt).not.toBeNull();
      // …so a retry is refused until the claim goes stale.
      expect((await post(`/api/candidates/${alpha}/merge`, editor, {})).status).toBe(409);
      const audits = await db.select().from(wikidataEdits);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ ok: false, errorCode: "network" });
    });
  });

  describe("POST /api/candidates/:id/merge after a mirror cleanup failure", () => {
    it("keeps the audit row and the merged status when the cleanup transaction fails", async () => {
      stubWikidata(() => mergeOk(101, 102));
      // The first transaction records the merge; the second cleans the mirror.
      const real = db.transaction.bind(db);
      const spy = vi.spyOn(db, "transaction");
      spy.mockImplementationOnce(real as typeof db.transaction).mockImplementationOnce(() => {
        throw new Error("Deadlock found when trying to get lock");
      });
      try {
        const { status, body } = await post<CandidateMergeResponse>(
          `/api/candidates/${alpha}/merge`,
          editor,
          {},
        );
        expect(status).toBe(200);
        expect(body.candidate).toMatchObject({ id: alpha, status: "merged" });
      } finally {
        spy.mockRestore();
      }

      expect(await candidateRow(alpha)).toMatchObject({
        status: "merged",
        resolution: "merged into Q10 (rev 102)",
      });
      const audits = await db.select().from(wikidataEdits);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ ok: true, fromRevid: 101, intoRevid: 102 });
      // The cleanup didn't happen: the mirror still holds Q20 and beta is open.
      expect(await itemQids()).toEqual(["Q10", "Q20", "Q30", "Q40"]);
      expect((await candidateRow(beta)).status).toBe("open");
    });
  });

  describe("POST /api/candidates/:id/dismiss guards", () => {
    it("never dismisses a merged candidate, and dismisses a merging one only once stale", async () => {
      await db
        .update(mergeCandidates)
        .set({ status: "merged" })
        .where(eq(mergeCandidates.id, alpha));
      expect((await post(`/api/candidates/${alpha}/dismiss`, editor)).status).toBe(409);
      expect((await candidateRow(alpha)).status).toBe("merged");
      // …so dismiss → reopen can't revive it either.
      expect((await post(`/api/candidates/${alpha}/reopen`, editor)).status).toBe(409);

      await db
        .update(mergeCandidates)
        .set({ status: "merging", resolvedAt: toSqlDatetime(new Date()) })
        .where(eq(mergeCandidates.id, beta));
      expect((await post(`/api/candidates/${beta}/dismiss`, editor)).status).toBe(409);
      expect((await candidateRow(beta)).status).toBe("merging");

      await db
        .update(mergeCandidates)
        .set({ resolvedAt: toSqlDatetime(addSeconds(new Date(), -MERGING_STALE_SECONDS - 60)) })
        .where(and(eq(mergeCandidates.id, beta), eq(mergeCandidates.status, "merging")));
      expect((await post(`/api/candidates/${beta}/dismiss`, editor)).status).toBe(200);
      expect((await candidateRow(beta)).status).toBe("dismissed");
    });
  });

  describe("POST /api/candidates/:id/reopen guards", () => {
    it("never reopens a merged candidate, and reopens a merging one only once stale", async () => {
      await db
        .update(mergeCandidates)
        .set({ status: "merged" })
        .where(eq(mergeCandidates.id, alpha));
      expect((await post(`/api/candidates/${alpha}/reopen`, editor)).status).toBe(409);

      await db
        .update(mergeCandidates)
        .set({ status: "merging", resolvedAt: toSqlDatetime(new Date()) })
        .where(eq(mergeCandidates.id, beta));
      expect((await post(`/api/candidates/${beta}/reopen`, editor)).status).toBe(409);

      await db
        .update(mergeCandidates)
        .set({ resolvedAt: toSqlDatetime(addSeconds(new Date(), -MERGING_STALE_SECONDS - 60)) })
        .where(and(eq(mergeCandidates.id, beta), eq(mergeCandidates.status, "merging")));
      expect((await post(`/api/candidates/${beta}/reopen`, editor)).status).toBe(200);
      expect((await candidateRow(beta)).status).toBe("open");
    });
  });
});
