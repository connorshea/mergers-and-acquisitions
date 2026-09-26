// Keeps CONVERTER_VERSION honest: converts the golden fixture lines exactly as
// the dump import stores them and checks the result against the last entry of
// CONVERTER_OUTPUTS. See server/converter-version.ts.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { type Entity, entityToItem } from "../src/lib/wikibase.ts";
import { CONVERTER_OUTPUTS, CONVERTER_VERSION } from "./converter-version.ts";
import { lineRevision, prepareRow } from "./dump-import.ts";

const FIXTURE = new URL("../test/fixtures/converter-golden.jsonl", import.meta.url);
const lines = readFileSync(FIXTURE, "utf8")
  .split("\n")
  .filter((l) => l.trim() !== "");
const entities = lines.map((l) => JSON.parse(l.replace(/,$/, "")) as Entity);

/** SHA-1 over everything upsertItems would store for each fixture item. */
function outputHash(): string {
  const hash = createHash("sha1");
  for (const entity of entities) {
    const item = entityToItem(entity);
    // The hash covers label, type, data, and external-id rows; the rows
    // themselves are included too, in case itemHash ever stops covering them.
    const { dataHash, ids } = prepareRow(item);
    hash.update(`${entity.id}\t${dataHash}\t${JSON.stringify(ids)}\n`);
  }
  return hash.digest("hex");
}

describe("CONVERTER_VERSION", () => {
  it("matches the converter's output on the golden fixtures", () => {
    const actual = outputHash();
    // Failed by hand so the message says what to do about it.
    if (actual !== CONVERTER_OUTPUTS.at(-1)) {
      throw new Error(
        `The entity → row conversion changed. Append "${actual}" to CONVERTER_OUTPUTS in ` +
          "server/converter-version.ts (never edit or remove an entry), so the next dump " +
          "import reconverts unedited items.",
      );
    }
    expect(CONVERTER_OUTPUTS.at(-1)).toBe(actual);
  });

  it("is derived from an append-only list of distinct outputs", () => {
    expect(CONVERTER_VERSION).toBe(CONVERTER_OUTPUTS.length);
    expect(new Set(CONVERTER_OUTPUTS).size).toBe(CONVERTER_OUTPUTS.length);
    for (const h of CONVERTER_OUTPUTS) expect(h).toMatch(/^[0-9a-f]{40}$/);
  });

  it("has fixtures that exercise every kind of value the converter handles", () => {
    const snaks = entities.flatMap((e) =>
      Object.values(e.claims ?? {}).flatMap((statements) =>
        statements.flatMap((s) => [s.mainsnak, ...Object.values(s.qualifiers ?? {}).flat()]),
      ),
    );
    const kinds = new Set(
      snaks.map((s) => (s.datavalue ? `${s.datavalue.type}/${s.datatype}` : s.snaktype)),
    );
    for (const kind of [
      "wikibase-entityid/wikibase-item",
      "time/time",
      "quantity/quantity",
      "monolingualtext/monolingualtext",
      "globecoordinate/globe-coordinate",
      "string/external-id",
      "string/url",
      "string/string",
      "string/commonsMedia",
      "somevalue",
      "novalue",
    ]) {
      expect(kinds).toContain(kind);
    }
    const ranks = new Set(
      entities.flatMap((e) => Object.values(e.claims ?? {}).flatMap((ss) => ss.map((s) => s.rank))),
    );
    expect([...ranks].sort()).toEqual(["deprecated", "normal", "preferred"]);
  });

  it("uses fixture lines the raw revision reader understands", () => {
    for (const [i, line] of lines.entries()) {
      expect(lineRevision(Buffer.from(line))).toEqual({
        qid: Number(entities[i].id.slice(1)),
        revid: entities[i].lastrevid,
      });
    }
  });
});
