import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  type EntityLabelRow,
  fetchAllProperties,
  fetchClassAncestors,
  fetchPlaceAncestors,
  fetchEntityLabels,
  fetchMirroredProps,
  fetchSubjectTypes,
  MAX_CONSECUTIVE_GIVE_UPS,
  parseSparqlResults,
  SparqlError,
  SparqlOutageError,
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
    expect((): unknown => JSON.parse(body)).toThrow(SyntaxError);
    const rows = parseSparqlResults(body);
    expect(rows[0]?.v?.value).toBe("a b"); // control char replaced with a space
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
  return [...query.matchAll(/wd:(Q\d+)/g)].map((m) => m[1]!);
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

  it(`stops with SparqlOutageError after ${MAX_CONSECUTIVE_GIVE_UPS} give-ups in a row`, async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new TypeError("fetch failed");
    });
    vi.stubGlobal("fetch", fetch);
    await expect(
      fetchEntityLabels(qids(4500), async () => {}, { ...FAST, tries: 1 }),
    ).rejects.toBeInstanceOf(SparqlOutageError);
    // Splits aren't give-ups: 2000 → 1000 → 500 → 250 → 125 gives up on Q1–Q125
    // (5 requests), then Q126–Q250 (1), then 250 → 125 for Q251–Q375 (2).
    expect(fetch).toHaveBeenCalledTimes(8);
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

const WD = "http://www.wikidata.org/entity/";
const uri = (id: string) => ({ type: "uri", value: `${WD}${id}` });
const results = (bindings: object[]) =>
  new Response(JSON.stringify({ results: { bindings } }), { status: 200 });

describe("fetchAllProperties", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const literal = (value: string) => ({ type: "literal", value });
  const datatype = (name: string) => ({ type: "uri", value: `http://wikiba.se/ontology#${name}` });

  it("dedupes by pid, keeping the first formatter and any row's mirrors flag", async () => {
    const steam = { p: uri("P1733"), pLabel: literal("Steam application ID") };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        results([
          {
            ...steam,
            type: datatype("ExternalId"),
            formatter: literal("https://store.steampowered.com/app/$1"),
          },
          // A second equally-ranked formatter: ignored.
          { ...steam, type: datatype("ExternalId"), formatter: literal("https://steamdb.info/$1") },
          // No formatter on the first row: the second row's is used.
          { p: uri("P2799"), pLabel: literal("BVMC person ID"), type: datatype("ExternalId") },
          {
            p: uri("P2799"),
            pLabel: literal("BVMC person ID"),
            formatter: literal("https://bvmc/$1"),
            mirrors: literal("true"),
          },
          { p: uri("P31"), pLabel: literal("instance of") },
          // Not a property id, or missing its label: skipped.
          { p: uri("Q5"), pLabel: literal("human") },
          { p: uri("P9") },
        ]),
      )
      .mockResolvedValueOnce(
        results([{ p: uri("P2799"), st: uri("statement/P2799-1"), cls: uri("Q5") }]),
      )
      .mockResolvedValueOnce(results([]));
    vi.stubGlobal("fetch", fetch);

    expect(await fetchAllProperties()).toEqual([
      {
        pid: "P1733",
        label: "Steam application ID",
        datatype: "ExternalId",
        formatterUrl: "https://store.steampowered.com/app/$1",
        mirrorsWikidata: false,
        subjectTypes: null,
      },
      {
        pid: "P2799",
        label: "BVMC person ID",
        datatype: "ExternalId",
        formatterUrl: "https://bvmc/$1",
        mirrorsWikidata: true,
        subjectTypes: [{ classes: ["Q5"], relation: "either", exceptions: [] }],
      },
      {
        pid: "P31",
        label: "instance of",
        datatype: null,
        formatterUrl: null,
        mirrorsWikidata: false,
        subjectTypes: null,
      },
    ]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});

describe("fetchMirroredProps", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the property ids, skipping anything else", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>(async () =>
        results([{ p: uri("P434") }, { p: uri("P8292") }, { p: uri("Q1") }, {}]),
      ),
    );
    expect([...(await fetchMirroredProps())]).toEqual(["P434", "P8292"]);
  });
});

describe("fetchSubjectTypes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("groups classes, relation, and exceptions by constraint statement", async () => {
    const st1 = uri("statement/P2799-1");
    const st2 = uri("statement/P2799-2");
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        results([
          { p: uri("P2799"), st: st1, cls: uri("Q5"), rel: uri("Q21503252") },
          { p: uri("P2799"), st: st1, cls: uri("Q16334295"), rel: uri("Q21503252") },
          { p: uri("P2799"), st: st2, cls: uri("Q43229") },
          // A somevalue class is a blank node, not an item: skipped.
          { p: uri("P1"), st: uri("statement/P1-1"), cls: { type: "bnode", value: "b0" } },
        ]),
      )
      .mockResolvedValueOnce(
        results([
          { st: st1, exc: uri("Q42") },
          { st: uri("statement/P9-9"), exc: uri("Q1") },
        ]),
      );
    vi.stubGlobal("fetch", fetch);
    const byPid = await fetchSubjectTypes();
    expect([...byPid]).toEqual([
      [
        "P2799",
        [
          { classes: ["Q5", "Q16334295"], relation: "instance", exceptions: ["Q42"] },
          { classes: ["Q43229"], relation: "either", exceptions: [] },
        ],
      ],
    ]);
  });
});

describe("fetchClassAncestors", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("records each class as its own ancestor, and skips a chunk that keeps failing", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      const [first] = requestedQids(init);
      if (first === "Q1001") return OOM();
      return results([
        { c: uri("Q1"), anc: uri("Q386724") },
        { c: uri("Q1"), anc: uri("Q1") },
      ]);
    });
    vi.stubGlobal("fetch", fetch);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ancestors, failed } = await fetchClassAncestors(qids(1500), { ...FAST, tries: 1 });
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("class ancestors: giving up on 500 classes (Q1001…)"),
    );
    error.mockRestore();
    expect(ancestors.get("Q1")).toEqual(["Q1", "Q386724"]);
    expect(ancestors.get("Q2")).toEqual(["Q2"]);
    expect(ancestors.size).toBe(1000);
    expect(failed).toEqual(qids(500, 1001));
  });
});

describe("fetchPlaceAncestors", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("flags country ancestors, drops the place itself, and skips a chunk that keeps failing", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      const [first] = requestedQids(init);
      if (first === "Q1001") return OOM();
      const country = { type: "literal", value: "true" };
      return results([
        { p: uri("Q1"), anc: uri("Q1490") },
        { p: uri("Q1"), anc: uri("Q17"), country },
        { p: uri("Q1"), anc: uri("Q1") },
        { p: uri("Q2"), anc: uri("Q17") },
        { p: uri("Q2"), anc: uri("Q17"), country },
      ]);
    });
    vi.stubGlobal("fetch", fetch);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ancestors, failed } = await fetchPlaceAncestors(qids(1500), { ...FAST, tries: 1 });
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("place ancestors: giving up on 500 places (Q1001…)"),
    );
    error.mockRestore();
    expect(ancestors.get("Q1")).toEqual([
      { ancestor: "Q1490", country: false },
      { ancestor: "Q17", country: true },
    ]);
    expect(ancestors.get("Q2")).toEqual([{ ancestor: "Q17", country: true }]);
    expect(ancestors.has("Q3")).toBe(false);
    expect(failed).toEqual(qids(500, 1001));
  });

  it("hands each chunk to onChunk instead of collecting it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>(async (_url, init) => {
        const [first = ""] = requestedQids(init);
        return results([{ p: uri(first), anc: uri("Q17") }]);
      }),
    );
    const seen: [number, string, string[]][] = [];
    const { ancestors, failed } = await fetchPlaceAncestors(qids(1500), {
      ...FAST,
      onChunk: async (places, chunk) => {
        for (const [qid, list] of chunk)
          seen.push([places.length, qid, list.map((e) => e.ancestor)]);
      },
    });
    expect(seen).toEqual([
      [1000, "Q1", ["Q17"]],
      [500, "Q1001", ["Q17"]],
    ]);
    expect(ancestors.size).toBe(0);
    expect(failed).toEqual([]);
  });

  // Chunks 1-based: which of a run's 1000-place chunks fail.
  const failingChunks = (failing: number[]) =>
    vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      const [first = ""] = requestedQids(init);
      const n = Math.ceil(Number(first.slice(1)) / 1000);
      if (failing.includes(n)) throw new TypeError("fetch failed");
      return results([{ p: uri(first), anc: uri("Q17") }]);
    });

  it("skips failed chunks that a success separates", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", failingChunks([2, 3, 5, 6]));
    const { failed } = await fetchPlaceAncestors(qids(7000), { ...FAST, tries: 1 });
    expect(failed).toEqual([...qids(2000, 1001), ...qids(2000, 4001)]);
  });

  it(`stops with SparqlOutageError after ${MAX_CONSECUTIVE_GIVE_UPS} failed chunks in a row`, async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetch = failingChunks([2, 3, 4]);
    vi.stubGlobal("fetch", fetch);
    const written: string[] = [];
    await expect(
      fetchPlaceAncestors(qids(6000), {
        ...FAST,
        tries: 1,
        onChunk: async (places) => {
          written.push(places[0]!);
        },
      }),
    ).rejects.toBeInstanceOf(SparqlOutageError);
    // The first chunk was written; the ones after the outage never asked for.
    expect(written).toEqual(["Q1"]);
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});
