import { describe, expect, it } from "vite-plus/test";
import { replicaConnConfig, sitelinkClashes } from "./sitelink-redirects.ts";
import { makeItem } from "../test/db-helpers.ts";

describe("sitelinkClashes", () => {
  it("returns both titles of each same-wiki clash, and nothing else", () => {
    const a = makeItem(
      "Q1",
      "A",
      {},
      {
        sitelinks: { enwiki: "Foo", dewiki: "Foo", frwiki: "Foo" },
      },
    );
    const b = makeItem(
      "Q2",
      "B",
      {},
      {
        sitelinks: { enwiki: "Foo (video game)", dewiki: "Foo", jawiki: "フー" },
      },
    );
    expect(sitelinkClashes(a, b)).toEqual([
      { wiki: "enwiki", title: "Foo" },
      { wiki: "enwiki", title: "Foo (video game)" },
    ]);
  });
});

describe("replicaConnConfig", () => {
  it("targets the wiki's analytics replica by default", () => {
    expect(replicaConnConfig("enwiki")).toMatchObject({
      host: "enwiki.analytics.db.svc.wikimedia.cloud",
      database: "enwiki_p",
    });
  });

  it("refuses anything that isn't a site id", () => {
    expect(() => replicaConnConfig("enwiki.evil.example")).toThrow(/Not a replica wiki id/);
    expect(() => replicaConnConfig("")).toThrow(/Not a replica wiki id/);
  });
});
