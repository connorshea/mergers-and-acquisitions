// Unit tests for the streaming dump scanner (server/dump-import.ts): the
// pre-filter, chunk-boundary handling, the best-rank P31 check, and the limit.
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vite-plus/test";
import type { Item } from "../src/lib/compare.ts";
import { VIDEO_GAME } from "../src/lib/import-classes.ts";
import type { Entity, Statement } from "../src/lib/wikibase.ts";
import { dumpGz } from "../test/dump-gz.ts";
import {
  dumpIdFor,
  dumpSlice,
  findMemberStart,
  formatDuration,
  isLockConflict,
  openDump,
  openDumpFile,
  scanDump,
} from "./dump-import.ts";

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
    classQids: [VIDEO_GAME],
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

  it("matches any of several classes in one pass, by the whole number", async () => {
    const entities = [
      item("Q10", { P31: [p31("Q11424")] }),
      // A prefix of one class (Q1142) and an extension of another (Q78891).
      item("Q11", { P31: [p31("Q1142")], P279: [p31("Q78891")] }),
      item("Q12", { P31: [p31("Q482994")] }),
    ];
    const matched: string[] = [];
    const stats = await scanDump(Readable.from([Buffer.from(dumpText(entities))]), {
      classQids: [VIDEO_GAME, "Q11424", "Q482994"],
      onItem: (i) => {
        matched.push(i.id);
      },
    });
    expect(matched).toEqual(["Q10", "Q12"]);
    // Q11 never reaches the parser.
    expect(stats.parsed).toBe(2);
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
      classQids: [VIDEO_GAME],
      onItem: (i) => {
        seen.push(i.id);
      },
    });
    expect(seen).toEqual(["Q1", "Q6"]);
    expect(stats.properties).toBe(0);
  });

  it("skips a hit line that doesn't parse when onSkip is given, and throws without it", async () => {
    const [first, ...rest] = dumpText(ENTITIES).split("\n");
    const text = [first, '{"type":"item","id":"Q9","claims":{"numeric-id":7889 oops', ...rest].join(
      "\n",
    );
    const skipped: string[] = [];
    const stats = await scanDump(Readable.from([Buffer.from(text)]), {
      classQids: [VIDEO_GAME],
      onItem: () => {},
      onSkip: (what) => {
        skipped.push(what);
      },
    });
    expect(stats).toMatchObject({ matched: 2, skipped: 1 });
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatch(/^unparseable line .*Q9/);

    await expect(collect(Readable.from([Buffer.from(text)]))).rejects.toThrow(SyntaxError);
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

  it("reports the size on disk and the bytes read so far", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dump-import-"));
    const text = dumpText(ENTITIES);
    const gz = gzipSync(text);
    await writeFile(join(dir, "dump.json.gz"), gz);
    await writeFile(join(dir, "dump.json"), text);
    for (const [name, size] of [
      ["dump.json.gz", gz.length],
      ["dump.json", Buffer.byteLength(text)],
    ] as const) {
      const file = openDumpFile(join(dir, name));
      expect(file.size).toBe(size);
      expect(file.read()).toBe(0);
      const { stats } = await collect(file.source);
      expect(stats.bytes).toBe(Buffer.byteLength(text));
      expect(file.read()).toBe(size);
    }
  });

  it("fails up front when the file is missing", () => {
    // stat() runs on open, so a bad path fails before any scan starts.
    expect(() => openDump("/nonexistent/dump.json.gz")).toThrow("ENOENT");
  });
});

describe("dump shards", () => {
  // Three batches, like the real dump's per-batch members, plus one stored
  // (uncompressed) member whose content contains a fake gzip header followed
  // by bytes that are not valid deflate data.
  const FAKE_HEADER = Buffer.from([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 3, 7, 7, 7, 7, 7, 7, 7, 7]);
  const decoy = Buffer.concat([
    Buffer.from('{"type":"item","id":"Q7","labels":{"en":{"value":"'),
    FAKE_HEADER,
    Buffer.from('"}},"claims":{}}'),
  ]);
  const fixture = dumpGz([ENTITIES.slice(0, 3), ENTITIES.slice(3, 5), decoy, ENTITIES.slice(5)]);

  async function writeFixture(): Promise<{ dir: string; gz: string; json: string }> {
    const dir = await mkdtemp(join(tmpdir(), "dump-shards-"));
    const gz = join(dir, "dump.json.gz");
    const json = join(dir, "dump.json");
    await writeFile(gz, fixture.gz);
    await writeFile(json, fixture.text);
    return { dir, gz, json };
  }

  it("finds member starts, skipping a header-like byte run inside a member", async () => {
    const { gz } = await writeFixture();
    expect(fixture.members[0]).toBe(0);
    for (let i = 0; i < fixture.members.length; i++) {
      const at = fixture.members[i];
      expect(findMemberStart(gz, at)).toBe(at);
      // Anywhere inside a member, the search lands on the next member.
      const next = fixture.members[i + 1] ?? fixture.gz.length;
      expect(findMemberStart(gz, at + 1)).toBe(next);
    }
    const fake = fixture.gz.indexOf(FAKE_HEADER);
    expect(fake).toBeGreaterThan(0);
    expect(fixture.members).not.toContain(fake);
    expect(findMemberStart(gz, fake)).not.toBe(fake);
    expect(findMemberStart(gz, fixture.gz.length)).toBe(fixture.gz.length);
  });

  it("partitions a .gz into whole members and a plain dump into whole lines", async () => {
    const { gz, json } = await writeFixture();
    for (const [path, size, isBoundary] of [
      [gz, fixture.gz.length, (at: number) => fixture.members.includes(at)],
      [json, fixture.text.length, (at: number) => fixture.text[at - 1] === 0x0a],
    ] as const) {
      for (const count of [1, 2, 3, 5, 40]) {
        const slices = Array.from({ length: count }, (_, index) =>
          dumpSlice(path, { index, count }),
        );
        expect(slices[0].start).toBe(0);
        expect(slices[count - 1].end).toBe(size);
        for (let i = 0; i < count; i++) {
          const { start, end } = slices[i];
          expect(end).toBeGreaterThanOrEqual(start);
          expect(i === 0 ? 0 : slices[i - 1].end).toBe(start);
          expect(start === 0 || start === size || isBoundary(start)).toBe(true);
        }
        // Read every shard: together they see the whole dump exactly once.
        const ids: string[] = [];
        let bytes = 0;
        let lines = 0;
        for (let index = 0; index < count; index++) {
          const file = openDumpFile(path, { index, count });
          expect(file.size).toBe(slices[index].end - slices[index].start);
          const { matched, stats } = await collect(file.source);
          expect(file.read()).toBe(file.size);
          ids.push(...matched.map((m) => m.id));
          bytes += stats.bytes;
          lines += stats.lines;
        }
        expect(ids).toEqual(["Q1", "Q6"]);
        expect(bytes).toBe(fixture.text.length);
        // A slice that ends mid-line (at a `,` member) counts its last line
        // itself, and the next slice counts the `,` — at most one extra per cut.
        expect(lines).toBeGreaterThanOrEqual(ENTITIES.length + 3);
        expect(lines).toBeLessThanOrEqual(ENTITIES.length + 3 + count - 1);
      }
    }
  });

  it("rejects a shard outside its count", async () => {
    const { gz } = await writeFixture();
    expect(() => dumpSlice(gz, { index: 2, count: 2 })).toThrow("out of range");
    expect(() => dumpSlice(gz, { index: 0, count: 0 })).toThrow("bad shard");
  });

  it("names a dump by the date in its file name, else by mtime and size", async () => {
    const { dir, gz } = await writeFixture();
    expect(dumpIdFor("/public/dumps/x/20260914/wikidata-20260914-all.json.gz")).toBe("20260914");
    expect(dumpIdFor(join(dir, "wikidata-20260921-lexemes.json.gz"))).toBe("20260921");
    const id = dumpIdFor(gz);
    expect(id).toMatch(/^\d+-\d+$/);
    expect(dumpIdFor(gz)).toBe(id);
  });
});

describe("formatDuration", () => {
  it("rounds to minutes and splits hours", () => {
    expect(formatDuration(0)).toBe("<1m");
    expect(formatDuration(29)).toBe("<1m");
    expect(formatDuration(31)).toBe("1m");
    expect(formatDuration(12 * 60)).toBe("12m");
    expect(formatDuration(3 * 3600 + 41 * 60)).toBe("3h 41m");
    expect(formatDuration(3600 + 5 * 60)).toBe("1h 05m");
    expect(formatDuration(Number.NaN)).toBe("?");
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("?");
    expect(formatDuration(-5)).toBe("?");
  });
});

describe("isLockConflict", () => {
  const driverError = (code: string) => Object.assign(new Error(code), { code });

  it("spots a deadlock or lock-wait timeout, bare or wrapped by Drizzle", () => {
    expect(isLockConflict(driverError("ER_LOCK_DEADLOCK"))).toBe(true);
    expect(isLockConflict(driverError("ER_LOCK_WAIT_TIMEOUT"))).toBe(true);
    const wrapped = new Error("Failed query: delete from ...", {
      cause: driverError("ER_LOCK_DEADLOCK"),
    });
    expect(isLockConflict(wrapped)).toBe(true);
  });

  it("leaves every other error to the one-by-one fallback", () => {
    expect(isLockConflict(driverError("ER_DATA_TOO_LONG"))).toBe(false);
    expect(isLockConflict(new Error("boom"))).toBe(false);
    expect(isLockConflict("ER_LOCK_DEADLOCK")).toBe(false);
    expect(isLockConflict(undefined)).toBe(false);
  });
});
