import { describe, expect, it } from "vite-plus/test";
import { parseSparqlResults } from "./sparql";

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
    expect(() => JSON.parse(body)).toThrow();
    const rows = parseSparqlResults(body);
    expect(rows[0].v?.value).toBe("a b"); // control char replaced with a space
  });

  it("returns an empty array when there are no bindings", () => {
    expect(parseSparqlResults('{"results":{}}')).toEqual([]);
    expect(parseSparqlResults("{}")).toEqual([]);
  });
});
