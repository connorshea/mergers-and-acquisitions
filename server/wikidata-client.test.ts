// Unit tests for the edit client's request shape, retries and error mapping,
// with every dependency (network, token store, clock) injected.
import { describe, expect, it, vi } from "vite-plus/test";
import { TokenError } from "./auth/tokens.ts";
import {
  addItemClaim,
  editRequest,
  fetchItemsForMergeCheck,
  finishRedirect,
  mergeItems,
  probeMerge,
  removeSitelink,
  revisionUrl,
  WikidataEditError,
  type WikidataClientDeps,
} from "./wikidata-client.ts";

const API = "https://wd.test/w/api.php";
const USER = { id: 7, username: "Alice" };

interface Call {
  method: string;
  params: URLSearchParams;
  headers: Record<string, string>;
}

type Reply = object | Response;

/**
 * Build deps whose `fetch` answers the CSRF query with a token and hands each
 * POST to `replies` in order (an object is sent as JSON 200).
 */
function makeDeps(replies: Reply[], opts: { csrf?: Reply[] } = {}) {
  const calls: Call[] = [];
  const posts = [...replies];
  const csrfs = opts.csrf ? [...opts.csrf] : [];
  let csrfN = 0;
  const deps: WikidataClientDeps = {
    fetch: vi.fn<WikidataClientDeps["fetch"]>(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const method = init?.method ?? "GET";
      const params =
        method === "POST"
          ? new URLSearchParams(String(init?.body as URLSearchParams))
          : new URL(url).searchParams;
      calls.push({ method, params, headers: init?.headers as Record<string, string> });
      expect(url.startsWith(API)).toBe(true);
      let reply: Reply | undefined;
      if (method === "GET") {
        reply =
          csrfs.length > 0
            ? csrfs.shift()
            : { query: { tokens: { csrftoken: `csrf-${++csrfN}` } } };
      } else {
        reply = posts.shift();
      }
      if (reply === undefined) throw new Error("unexpected request");
      return reply instanceof Response ? reply : Response.json(reply);
    }),
    getAccessToken: vi.fn<WikidataClientDeps["getAccessToken"]>(async () => "access-token"),
    deleteTokens: vi.fn<WikidataClientDeps["deleteTokens"]>(async () => {}),
    apiUrl: () => API,
    sleep: vi.fn<WikidataClientDeps["sleep"]>(async () => {}),
  };
  return { deps, calls };
}

const MERGE_OK = {
  success: 1,
  redirected: 1,
  from: { id: "Q20", type: "item", lastrevid: 3000000001 },
  to: { id: "Q10", type: "item", lastrevid: 3000000002 },
};

const apiError = (code: string, text = `${code} text`) => ({
  errors: [{ code, text, module: "x" }],
});

/** Await a call that must reject with a WikidataEditError, returning it. */
async function failure(promise: Promise<unknown>): Promise<WikidataEditError> {
  const err = await promise.then(
    () => new Error("expected the edit to fail"),
    (e: unknown) => e,
  );
  if (!(err instanceof WikidataEditError)) throw err;
  return err;
}

describe("mergeItems", () => {
  it("fetches an asserted CSRF token, then posts the merge with the guard parameters", async () => {
    const { deps, calls } = makeDeps([MERGE_OK]);
    const result = await mergeItems(
      USER,
      {
        fromQid: "Q20",
        intoQid: "Q10",
        ignoreConflicts: ["description", "sitelink"],
        summary: "s",
      },
      deps,
    );
    expect(result).toEqual({ fromRevid: 3000000001, intoRevid: 3000000002, redirected: true });

    expect(calls).toHaveLength(2);
    const [csrf, edit] = calls;
    expect(csrf.method).toBe("GET");
    expect(Object.fromEntries(csrf.params)).toMatchObject({
      action: "query",
      meta: "tokens",
      type: "csrf",
      assert: "user",
      assertuser: "Alice",
      format: "json",
      formatversion: "2",
      errorformat: "plaintext",
    });
    expect(csrf.headers.Authorization).toBe("Bearer access-token");
    expect(csrf.headers["User-Agent"]).toMatch(/mergers-and-acquisitions|\(/);

    expect(edit.method).toBe("POST");
    expect(Object.fromEntries(edit.params)).toEqual({
      action: "wbmergeitems",
      fromid: "Q20",
      toid: "Q10",
      ignoreconflicts: "description|sitelink",
      summary: "s",
      token: "csrf-1",
      assert: "user",
      assertuser: "Alice",
      format: "json",
      formatversion: "2",
      errorformat: "plaintext",
    });
    expect(edit.params.has("bot")).toBe(false);
    // A merge is interactive, so it skips the lag guard.
    expect(edit.params.has("maxlag")).toBe(false);
  });

  it("omits ignoreconflicts entirely when nothing is overridden, and reads redirected=0", async () => {
    const { deps, calls } = makeDeps([{ ...MERGE_OK, redirected: 0 }]);
    const result = await mergeItems(
      USER,
      { fromQid: "Q20", intoQid: "Q10", ignoreConflicts: [], summary: "s" },
      deps,
    );
    expect(result.redirected).toBe(false);
    expect(calls[1].params.has("ignoreconflicts")).toBe(false);
  });

  it("retries once with a fresh token on badtoken, then gives up", async () => {
    const { deps, calls } = makeDeps([apiError("badtoken"), MERGE_OK]);
    await mergeItems(
      USER,
      { fromQid: "Q20", intoQid: "Q10", ignoreConflicts: [], summary: "s" },
      deps,
    );
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST", "GET", "POST"]);
    expect(calls[1].params.get("token")).toBe("csrf-1");
    expect(calls[3].params.get("token")).toBe("csrf-2");

    const twice = makeDeps([apiError("badtoken"), apiError("badtoken")]);
    const err = await failure(
      mergeItems(
        USER,
        { fromQid: "Q20", intoQid: "Q10", ignoreConflicts: [], summary: "s" },
        twice.deps,
      ),
    );
    expect(err.code).toBe("badtoken");
    expect(twice.calls).toHaveLength(4);
  });

  it("sends maxlag by default and omits it when the caller opts out", async () => {
    const { deps, calls } = makeDeps([{ success: 1 }, { success: 1 }]);
    await editRequest(USER, { action: "x" }, deps);
    await editRequest(USER, { action: "x" }, deps, { maxlag: false });
    const posts = calls.filter((call) => call.method === "POST");
    expect(posts[0].params.get("maxlag")).toBe("5");
    expect(posts[1].params.has("maxlag")).toBe(false);
  });

  it("waits out Retry-After (capped) and retries once on maxlag", async () => {
    const lagged = Response.json(apiError("maxlag", "Waiting for a replica"), {
      headers: { "Retry-After": "3" },
    });
    const { deps, calls } = makeDeps([lagged, { success: 1 }]);
    await editRequest(USER, { action: "x" }, deps);
    expect(calls[1].params.get("maxlag")).toBe("5");
    expect(deps.sleep).toHaveBeenCalledWith(3000);
    // The CSRF token is still good; only the edit is re-sent.
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST", "POST"]);

    const capped = makeDeps([
      Response.json(apiError("maxlag"), { headers: { "Retry-After": "60" } }),
      Response.json(apiError("maxlag")),
    ]);
    const err = await failure(editRequest(USER, { action: "x" }, capped.deps));
    expect(capped.deps.sleep).toHaveBeenCalledTimes(1);
    expect(capped.deps.sleep).toHaveBeenCalledWith(10_000);
    expect(err.code).toBe("maxlag");
    expect(err.kind).toBe("wikidata-error");
  });

  it("drops the stored tokens and asks for a re-login when the grant is rejected", async () => {
    for (const code of [
      "mwoauth-invalid-authorization",
      "assertuserfailed",
      "assertnameduserfailed",
    ]) {
      const { deps } = makeDeps([], { csrf: [apiError(code)] });
      const err = await failure(editRequest(USER, { action: "x" }, deps));
      expect(err.kind).toBe("login-required");
      expect(err.code).toBe(code);
      expect(deps.deleteTokens).toHaveBeenCalledWith(7);
    }
  });

  it("maps a missing/revoked stored token to login-required without touching the API", async () => {
    const { deps, calls } = makeDeps([]);
    deps.getAccessToken = vi.fn<WikidataClientDeps["getAccessToken"]>(async () => {
      throw new TokenError("revoked", "gone");
    });
    const err = await failure(editRequest(USER, { action: "x" }, deps));
    expect(err.kind).toBe("login-required");
    expect(err.code).toBe("revoked");
    expect(calls).toHaveLength(0);
    expect(deps.deleteTokens).not.toHaveBeenCalled();
  });

  it("surfaces Wikidata's own errors verbatim with the right kind", async () => {
    const cases: [object, string, string][] = [
      [
        apiError("failed-modify", "Conflicting descriptions for language en"),
        "conflict",
        "Conflicting descriptions for language en",
      ],
      [
        apiError(
          "failed-modify",
          "The two items cannot be merged because one of them links to the other using property P1889",
        ),
        "conflict",
        "The two items cannot be merged because one of them links to the other using property P1889",
      ],
      [
        apiError("failed-modify", "Item Q20 is a redirect"),
        "wikidata-error",
        "Item Q20 is a redirect",
      ],
      [
        apiError("permissiondenied", "You do not have permission"),
        "permission-denied",
        "You do not have permission",
      ],
      [apiError("blocked", "You have been blocked"), "blocked", "You have been blocked"],
      [apiError("ratelimited", "Slow down"), "rate-limited", "Slow down"],
      // The legacy (non-plaintext) error shape is understood too.
      [{ error: { code: "protectedpage", info: "Protected" } }, "permission-denied", "Protected"],
    ];
    for (const [reply, kind, message] of cases) {
      const { deps } = makeDeps([reply]);
      const err = await failure(editRequest(USER, { action: "x" }, deps));
      expect(err.kind).toBe(kind);
      expect(err.message).toBe(message);
      expect(deps.deleteTokens).not.toHaveBeenCalled();
    }
  });

  it("treats a non-JSON HTTP failure and a thrown fetch as network problems", async () => {
    const { deps } = makeDeps([new Response("<html>", { status: 503 })]);
    const err = await failure(editRequest(USER, { action: "x" }, deps));
    expect(err.kind).toBe("network");
    expect(err.code).toBe("http-503");

    const down = makeDeps([]);
    down.deps.fetch = vi.fn<WikidataClientDeps["fetch"]>(async () => {
      throw new TypeError("fetch failed");
    });
    const err2 = await failure(editRequest(USER, { action: "x" }, down.deps));
    expect(err2.kind).toBe("network");
    expect(err2.message).toContain("fetch failed");

    const tooMany = makeDeps([new Response("", { status: 429 })]);
    expect((await failure(editRequest(USER, { action: "x" }, tooMany.deps))).kind).toBe(
      "rate-limited",
    );
  });

  it("rejects the anonymous CSRF token", async () => {
    const { deps } = makeDeps([], { csrf: [{ query: { tokens: { csrftoken: "+\\" } } }] });
    const err = await failure(editRequest(USER, { action: "x" }, deps));
    expect(err.code).toBe("notoken");
  });

  it("fails loudly when success comes back without revision ids", async () => {
    const { deps } = makeDeps([{ success: 1 }]);
    const err = await failure(
      mergeItems(USER, { fromQid: "Q20", intoQid: "Q10", ignoreConflicts: [], summary: "s" }, deps),
    );
    expect(err.code).toBe("unexpected-response");
  });
});

describe("finishRedirect", () => {
  const CLEAR_OK = { success: 1, entity: { id: "Q20", type: "item", lastrevid: 3000000003 } };
  const REDIRECT_OK = { success: 1, redirect: "Q10" };

  it("clears the source with baserevid, then redirects it to the target", async () => {
    const { deps, calls } = makeDeps([CLEAR_OK, REDIRECT_OK]);
    const result = await finishRedirect(
      USER,
      { fromQid: "Q20", intoQid: "Q10", baseRevid: 3000000001, summary: "s" },
      deps,
    );
    expect(result).toEqual({ clearRevid: 3000000003 });

    // Two edits, each with its own asserted CSRF token: clear then redirect.
    const posts = calls.filter((call) => call.method === "POST");
    expect(posts).toHaveLength(2);
    expect(Object.fromEntries(posts[0].params)).toMatchObject({
      action: "wbeditentity",
      id: "Q20",
      baserevid: "3000000001",
      clear: "1",
      data: "{}",
      summary: "s",
      assert: "user",
      assertuser: "Alice",
    });
    expect(Object.fromEntries(posts[1].params)).toMatchObject({
      action: "wbcreateredirect",
      from: "Q20",
      to: "Q10",
      assert: "user",
      assertuser: "Alice",
    });
    // Part of the user's merge, so neither edit carries the lag guard.
    expect(posts.every((post) => !post.params.has("maxlag"))).toBe(true);
  });

  it("fails without attempting the redirect when the clear returns no revision id", async () => {
    const { deps, calls } = makeDeps([{ success: 1, entity: { id: "Q20" } }]);
    const err = await failure(
      finishRedirect(USER, { fromQid: "Q20", intoQid: "Q10", baseRevid: 1, summary: "s" }, deps),
    );
    expect(err.code).toBe("unexpected-response");
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  it("surfaces a failed clear as a WikidataEditError and never redirects", async () => {
    const { deps, calls } = makeDeps([apiError("editconflict", "edit conflict")]);
    const err = await failure(
      finishRedirect(USER, { fromQid: "Q20", intoQid: "Q10", baseRevid: 1, summary: "s" }, deps),
    );
    expect(err.code).toBe("editconflict");
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  it("surfaces a failed redirect after the clear already happened", async () => {
    const { deps, calls } = makeDeps([CLEAR_OK, apiError("no-such-entity")]);
    const err = await failure(
      finishRedirect(USER, { fromQid: "Q20", intoQid: "Q10", baseRevid: 1, summary: "s" }, deps),
    );
    expect(err.code).toBe("no-such-entity");
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(2);
  });
});

describe("addItemClaim", () => {
  it("posts a wbcreateclaim with an item value and returns the revision", async () => {
    const { deps, calls } = makeDeps([
      { success: 1, pageinfo: { lastrevid: 42 }, claim: { id: "Q20$x" } },
    ]);
    const result = await addItemClaim(
      USER,
      { qid: "Q20", property: "P1889", target: "Q10", summary: "s" },
      deps,
    );
    expect(result).toEqual({ revid: 42 });
    expect(Object.fromEntries(calls[1].params)).toMatchObject({
      action: "wbcreateclaim",
      entity: "Q20",
      property: "P1889",
      snaktype: "value",
      value: JSON.stringify({ "entity-type": "item", id: "Q10" }),
      summary: "s",
      token: "csrf-1",
    });
    // The user is waiting on it, so it skips the lag guard.
    expect(calls[1].params.has("maxlag")).toBe(false);
  });
});

describe("removeSitelink", () => {
  it("posts a wbsetsitelink with no title and returns the revision", async () => {
    const { deps, calls } = makeDeps([
      { success: 1, entity: { id: "Q20", lastrevid: 43, sitelinks: { enwiki: { removed: "" } } } },
    ]);
    const result = await removeSitelink(USER, { qid: "Q20", wiki: "enwiki", summary: "s" }, deps);
    expect(result).toEqual({ revid: 43 });
    expect(Object.fromEntries(calls[1].params)).toMatchObject({
      action: "wbsetsitelink",
      id: "Q20",
      linksite: "enwiki",
      summary: "s",
      token: "csrf-1",
    });
    expect(calls[1].params.has("linktitle")).toBe(false);
    expect(calls[1].params.has("maxlag")).toBe(false);
  });

  it("maps a refusal to a WikidataEditError", async () => {
    const { deps } = makeDeps([apiError("protectedpage")]);
    const err = await failure(
      removeSitelink(USER, { qid: "Q20", wiki: "enwiki", summary: "s" }, deps),
    );
    expect(err.kind).toBe("permission-denied");
  });
});

describe("probeMerge", () => {
  const info = (fromRedirect: boolean) => ({
    query: {
      pages: [
        { title: "Q20", lastrevid: 501, ...(fromRedirect ? { redirect: true } : {}) },
        { title: "Q10", lastrevid: 502 },
      ],
    },
  });

  it("reports a source that now redirects to the target, with both revisions", async () => {
    const { deps, calls } = makeDeps([], {
      csrf: [info(true), { query: { redirects: [{ from: "Q20", to: "Q10" }] } }],
    });
    expect(await probeMerge(USER, "Q20", "Q10", deps)).toEqual({
      redirectedTo: "Q10",
      fromRevid: 501,
      intoRevid: 502,
    });
    expect(calls.map((c) => c.method)).toEqual(["GET", "GET"]);
    expect(calls[0].params.get("titles")).toBe("Q20|Q10");
    expect(calls[1].params.get("redirects")).toBe("1");
  });

  it("reports no redirect without a second query, and a redirect elsewhere as-is", async () => {
    const plain = makeDeps([], { csrf: [info(false)] });
    expect((await probeMerge(USER, "Q20", "Q10", plain.deps)).redirectedTo).toBeNull();
    expect(plain.calls).toHaveLength(1);

    const elsewhere = makeDeps([], {
      csrf: [info(true), { query: { redirects: [{ from: "Q20", to: "Q99" }] } }],
    });
    expect((await probeMerge(USER, "Q20", "Q10", elsewhere.deps)).redirectedTo).toBe("Q99");
  });

  it("fails as a network problem when Wikidata is still unreachable", async () => {
    const down = makeDeps([]);
    down.deps.fetch = vi.fn<WikidataClientDeps["fetch"]>(async () => {
      throw new TypeError("fetch failed");
    });
    const err = await failure(probeMerge(USER, "Q20", "Q10", down.deps));
    expect(err.kind).toBe("network");
  });
});

describe("fetchItemsForMergeCheck", () => {
  const entities = {
    entities: {
      Q20: {
        id: "Q20",
        type: "item",
        sitelinks: { enwiki: { title: "Foo (video game)" } },
        claims: {},
      },
      Q10: { id: "Q10", type: "item", sitelinks: { enwiki: { title: "Foo" } }, claims: {} },
    },
  };

  it("asks only for sitelinks and claims and maps both items", async () => {
    const { deps, calls } = makeDeps([], { csrf: [entities] });
    const [from, into] = await fetchItemsForMergeCheck(USER, ["Q20", "Q10"], deps);
    expect(from.sitelinks).toEqual({ enwiki: "Foo (video game)" });
    expect(into.sitelinks).toEqual({ enwiki: "Foo" });
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
    expect(Object.fromEntries(calls[0].params)).toMatchObject({
      action: "wbgetentities",
      ids: "Q20|Q10",
      props: "sitelinks|claims",
    });
  });

  it("throws when Wikidata returns no data for one of the items", async () => {
    const { deps } = makeDeps([], {
      csrf: [{ entities: { Q10: { id: "Q10", type: "item" } } }],
    });
    const err = await failure(fetchItemsForMergeCheck(USER, ["Q20", "Q10"], deps));
    expect(err.message).toContain("Q20");
  });

  it("maps an API error to a WikidataEditError", async () => {
    const { deps } = makeDeps([], { csrf: [apiError("internal_api_error")] });
    const err = await failure(fetchItemsForMergeCheck(USER, ["Q20", "Q10"], deps));
    expect(err).toBeInstanceOf(WikidataEditError);
  });
});

describe("revisionUrl", () => {
  it("links to the diff on the wiki the API endpoint belongs to", () => {
    expect(revisionUrl(5, "https://test.wikidata.org/w/api.php")).toBe(
      "https://test.wikidata.org/w/index.php?diff=prev&oldid=5",
    );
    expect(revisionUrl(5, "not a url")).toBe(
      "https://www.wikidata.org/w/index.php?diff=prev&oldid=5",
    );
  });
});
