// Unit tests for the streaming dump scanner (server/dump-import.ts): the
// pre-filter, chunk-boundary handling, the best-rank P31 check, and the limit.
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vite-plus/test";
import type { Item } from "../src/lib/compare.ts";
import type { Entity, Statement } from "../src/lib/wikibase.ts";
import { openDump, scanDump, VIDEO_GAME } from "./dump-import.ts";

const itemRef = (qid: string) => ({
  type: "wikibase-entityid",
  value: { "entity-type": "item", "numeric-id": Number(qid.slice(1)), id: qid },
});
const p31 = (qid: string, rank: Statement["rank"] = "normal"): Statement => ({
  mainsnak: {
    snaktype: "value",
    property: "P31",
    datatype: "wikibase-item",
    datavalue: itemRef(qid),
  },
  rank,
});
const item = (id: string, claims: Record<string, Statement[]>, label = id): Entity => ({
  type: "item",
  id,
  labels: { en: { value: label } },
  claims,
});

/** Serialize entities the way the dump does: `[`, one `{…},` per line, `]`. */
function dumpText(entities: object[]): string {
  return `[\n${entities.map((e) => `${JSON.stringify(e)},\n`).join("")}]\n`;
}

/** A readable that yields the text in fixed-size pieces (to cross line boundaries). */
function chunked(text: string, size: number): Readable {
  const buf = Buffer.from(text);
  const pieces: Buffer[] = [];
  for (let i = 0; i < buf.length; i += size) pieces.push(buf.subarray(i, i + size));
  return Readable.from(pieces);
}

const ENTITIES = [
  item("Q1", { P31: [p31("Q7889")] }, "Doom"),
  // Mentions Q7889 in another statement only: passes the pre-filter, not P31.
  item("Q2", { P31: [p31("Q5")], P279: [p31("Q7889")] }),
  // Q78890 must not trip the "numeric-id":7889 needle.
  item("Q3", { P31: [p31("Q78890")] }),
  // Deprecated-only P31 → not an instance.
  item("Q4", { P31: [p31("Q7889", "deprecated")] }),
  // A preferred non-game P31 overrides the normal one (truthy semantics).
  item("Q5", { P31: [p31("Q7889"), p31("Q7397", "preferred")] }),
  item("Q6", { P31: [p31("Q7889", "preferred"), p31("Q7397")] }, "Quake"),
  { type: "property", id: "P1733", datatype: "external-id", labels: { en: { value: "Steam ID" } } },
  // Not an item: ignored even though it names the class.
  { type: "lexeme", id: "L1", claims: { P31: [p31("Q7889")] } },
];

async function collect(source: Readable, opts: { limit?: number } = {}) {
  const matched: Item[] = [];
  const properties: string[] = [];
  const stats = await scanDump(source, {
    classQid: VIDEO_GAME,
    limit: opts.limit,
    onItem: (i) => {
      matched.push(i);
    },
    onProperty: (e) => {
      properties.push(e.id);
    },
  });
  return { matched, properties, stats };
}

describe("scanDump", () => {
  it("keeps only items whose best-rank P31 is the class, plus property entities", async () => {
    const { matched, properties, stats } = await collect(
      Readable.from([Buffer.from(dumpText(ENTITIES))]),
    );
    expect(matched.map((m) => m.id)).toEqual(["Q1", "Q6"]);
    expect(matched[0].labels.en).toBe("Doom");
    expect(properties).toEqual(["P1733"]);
    expect(stats).toMatchObject({
      lines: ENTITIES.length + 2,
      // Q3 never reaches the parser (digit boundary); the other seven do, and
      // L1 is dropped after parsing for not being an item.
      parsed: 7,
      matched: 2,
      properties: 1,
      stopped: false,
    });
    expect(stats.bytes).toBe(Buffer.byteLength(dumpText(ENTITIES)));
  });

  it("is insensitive to where the chunk boundaries fall", async () => {
    const text = dumpText(ENTITIES);
    for (const size of [1, 7, 64, 1000, text.length + 5]) {
      const { matched, properties, stats } = await collect(chunked(text, size));
      expect(matched.map((m) => m.id)).toEqual(["Q1", "Q6"]);
      expect(properties).toEqual(["P1733"]);
      expect(stats.lines).toBe(ENTITIES.length + 2);
    }
  });

  it("stops early at the limit and says so", async () => {
    const { matched, stats } = await collect(chunked(dumpText(ENTITIES), 50), { limit: 1 });
    expect(matched.map((m) => m.id)).toEqual(["Q1"]);
    expect(stats.matched).toBe(1);
    expect(stats.stopped).toBe(true);
  });

  it("tolerates a dump without a trailing newline", async () => {
    const text = dumpText(ENTITIES).trimEnd();
    const { matched } = await collect(Readable.from([Buffer.from(text)]));
    expect(matched.map((m) => m.id)).toEqual(["Q1", "Q6"]);
  });

  it("skips property entities without a handler", async () => {
    const seen: string[] = [];
    const stats = await scanDump(Readable.from([Buffer.from(dumpText(ENTITIES))]), {
      classQid: VIDEO_GAME,
      onItem: (i) => {
        seen.push(i.id);
      },
    });
    expect(seen).toEqual(["Q1", "Q6"]);
    expect(stats.properties).toBe(0);
  });
});

describe("openDump", () => {
  it("inflates a .gz dump and reads a plain one as-is", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dump-import-"));
    const text = dumpText(ENTITIES);
    await writeFile(join(dir, "dump.json.gz"), gzipSync(text));
    await writeFile(join(dir, "dump.json"), text);
    for (const name of ["dump.json.gz", "dump.json"]) {
      const { matched, stats } = await collect(openDump(join(dir, name)));
      expect(matched.map((m) => m.id)).toEqual(["Q1", "Q6"]);
      expect(stats.bytes).toBe(Buffer.byteLength(text));
    }
  });

  it("refuses the bzip2 dump", () => {
    expect(() => openDump("/x/latest-all.json.bz2")).toThrow("use the .gz dump");
  });

  it("fails the scan when the file is missing", async () => {
    await expect(collect(openDump("/nonexistent/dump.json.gz"))).rejects.toThrow("ENOENT");
  });
});
