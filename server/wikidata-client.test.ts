// Unit tests for the edit client's request shape, retries and error mapping,
// with every dependency (network, token store, clock) injected.
import { describe, expect, it, vi } from "vite-plus/test";
import { TokenError } from "./auth/tokens.ts";
import {
  addItemClaim,
  editRequest,
  mergeItems,
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
      maxlag: "5",
      format: "json",
      formatversion: "2",
      errorformat: "plaintext",
    });
    expect(edit.params.has("bot")).toBe(false);
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

  it("waits out Retry-After (capped) and retries once on maxlag", async () => {
    const lagged = Response.json(apiError("maxlag", "Waiting for a replica"), {
      headers: { "Retry-After": "3" },
    });
    const { deps, calls } = makeDeps([lagged, MERGE_OK]);
    await mergeItems(
      USER,
      { fromQid: "Q20", intoQid: "Q10", ignoreConflicts: [], summary: "s" },
      deps,
    );
    expect(deps.sleep).toHaveBeenCalledWith(3000);
    // The CSRF token is still good; only the edit is re-sent.
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST", "POST"]);

    const capped = makeDeps([
      Response.json(apiError("maxlag"), { headers: { "Retry-After": "60" } }),
      Response.json(apiError("maxlag")),
    ]);
    const err = await failure(
      mergeItems(
        USER,
        { fromQid: "Q20", intoQid: "Q10", ignoreConflicts: [], summary: "s" },
        capped.deps,
      ),
    );
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
      maxlag: "5",
    });
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
