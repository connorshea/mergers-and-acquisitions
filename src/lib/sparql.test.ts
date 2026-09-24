import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  type EntityLabelRow,
  fetchEntityLabels,
  parseSparqlResults,
  SparqlError,
  sparqlSelectWithRetry,
} from "./sparql.ts";

describe("parseSparqlResults", () => {
  it("parses a normal SPARQL JSON results body", () => {
    const body = JSON.stringify({
      results: { bindings: [{ v: { type: "literal", value: "hello" } }] },
    });
    expect(parseSparqlResults(body)).toEqual([{ v: { type: "literal", value: "hello" } }]);
  });

  it("recovers from a raw control character inside a string literal (QLever quirk)", () => {
    // A raw newline (0x0A) inside the value — invalid JSON that JSON.parse rejects.
    const body = '{"results":{"bindings":[{"v":{"type":"literal","value":"a\nb"}}]}}';
    expect(() => JSON.parse(body)).toThrow(SyntaxError);
    const rows = parseSparqlResults(body);
    expect(rows[0].v?.value).toBe("a b"); // control char replaced with a space
  });

  it("returns an empty array when there are no bindings", () => {
    expect(parseSparqlResults('{"results":{}}')).toEqual([]);
    expect(parseSparqlResults("{}")).toEqual([]);
  });
});

// QLever's reply when it is out of memory (seen in production).
const OOM = () =>
  new Response(
    JSON.stringify({ exception: "Tried to allocate 250 kB, but only 39542 B were available" }),
    { status: 500 },
  );

/** A SPARQL JSON body giving each QID an English label "label <qid>". */
function labelsBody(qids: string[]): Response {
  const bindings = qids.map((q) => ({
    v: { type: "uri", value: `http://www.wikidata.org/entity/${q}` },
    vLabel: { type: "literal", value: `label ${q}`, "xml:lang": "en" },
  }));
  return new Response(JSON.stringify({ results: { bindings } }), { status: 200 });
}

/** The QIDs in a request's VALUES clause. */
function requestedQids(init?: RequestInit): string[] {
  const query = new URLSearchParams(init?.body as string).get("query") ?? "";
  return [...query.matchAll(/wd:(Q\d+)/g)].map((m) => m[1]);
}

const FAST = { baseDelayMs: 0, pauseMs: 0 };
const qids = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `Q${from + i}`);

describe("sparqlSelectWithRetry", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("retries transient failures (5xx, 429, network) and then succeeds", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(OOM())
      .mockResolvedValueOnce(new Response("slow down", { status: 429 }))
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockImplementation(async (_url, init) => labelsBody(requestedQids(init)));
    vi.stubGlobal("fetch", fetch);

    const bindings = await sparqlSelectWithRetry("SELECT * WHERE { VALUES ?v { wd:Q1 } }", FAST);
    expect(bindings).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("does not retry a bad query (4xx)", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response("parse error", { status: 400 }),
    );
    vi.stubGlobal("fetch", fetch);

    const err = await sparqlSelectWithRetry("nonsense", FAST).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SparqlError);
    expect((err as SparqlError).status).toBe(400);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("fetchEntityLabels", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("hands each chunk's labels to onRows as it arrives", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>(async (_url, init) => labelsBody(requestedQids(init))),
    );
    const batches: EntityLabelRow[][] = [];
    const progress: number[] = [];
    const result = await fetchEntityLabels(
      qids(4500),
      async (rows) => {
        batches.push(rows);
      },
      { ...FAST, onProgress: (p) => progress.push(p.done) },
    );
    expect(batches.map((b) => b.length)).toEqual([2000, 2000, 500]);
    expect(progress).toEqual([2000, 4000, 4500]);
    expect(result).toEqual({ fetched: 4500, failedQids: [] });
  });

  it("splits a chunk QLever keeps failing on and skips only the QIDs that never succeed", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    // Any request that includes Q7 fails every time (as a persistently
    // oversized query would); everything else succeeds.
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>(async (_url, init) => {
        const requested = requestedQids(init);
        return requested.includes("Q7") ? OOM() : labelsBody(requested);
      }),
    );
    const written: string[] = [];
    const result = await fetchEntityLabels(
      qids(2500),
      async (rows) => {
        written.push(...rows.map((r) => r.qid));
      },
      { ...FAST, tries: 2 },
    );
    // The first 2000-chunk halves down to the 125-QID slice holding Q7
    // (Q1–Q125); that one is skipped, everything else is written.
    expect(result.failedQids).toEqual(qids(125));
    expect(result.fetched).toBe(2500 - 125);
    expect(written).toHaveLength(2500 - 125);
    expect(written).not.toContain("Q7");
    expect(written).toContain("Q2500");
  });

  it("propagates a non-transient error instead of skipping", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>(async () => new Response("bad", { status: 400 })),
    );
    await expect(fetchEntityLabels(qids(10), async () => {}, FAST)).rejects.toBeInstanceOf(
      SparqlError,
    );
  });
});
