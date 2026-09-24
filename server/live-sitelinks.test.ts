import { describe, expect, it, vi } from "vite-plus/test";
import { attachLiveSitelinkRedirects } from "./live-sitelinks.ts";
import { makeItem } from "../test/db-helpers.ts";

describe("attachLiveSitelinkRedirects", () => {
  it("asks each clashing wiki about both pages and records the redirects", async () => {
    const a = makeItem(
      "Q1",
      "Foo",
      {},
      { sitelinks: { enwiki: "Foo", dewiki: "Foo", frwiki: "Foo" } },
    );
    const b = makeItem(
      "Q2",
      "Foo",
      {},
      {
        sitelinks: { enwiki: "Foo (video game)", dewiki: "Foo (Spiel)", frwiki: "Foo" },
      },
    );
    const urls: URL[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input as string | URL));
      urls.push(url);
      const redirects =
        url.host === "en.wikipedia.org"
          ? [{ from: "Foo (video game)", to: "Foo" }]
          : [{ from: "Foo", to: "Foo", tointerwiki: "en" }];
      return Response.json({ query: { redirects } });
    });
    await attachLiveSitelinkRedirects(a, b, fetchImpl);
    // frwiki doesn't clash, so it isn't asked.
    expect(urls.map((u) => u.host).sort()).toEqual(["de.wikipedia.org", "en.wikipedia.org"]);
    expect(urls.find((u) => u.host === "en.wikipedia.org")!.searchParams.get("titles")).toBe(
      "Foo|Foo (video game)",
    );
    expect(a.sitelinkRedirects).toEqual({ dewiki: "en:Foo" });
    expect(b.sitelinkRedirects).toEqual({ enwiki: "Foo" });
  });

  it("keeps the section a redirect points at", async () => {
    const a = makeItem("Q1", "Halo 3", {}, { sitelinks: { enwiki: "Halo 3" } });
    const b = makeItem("Q2", "Halo 3: ODST", {}, { sitelinks: { enwiki: "Halo 3: ODST" } });
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({
        query: { redirects: [{ from: "Halo 3: ODST", to: "Halo 3", tofragment: "ODST" }] },
      }),
    );
    await attachLiveSitelinkRedirects(a, b, fetchImpl);
    expect(b.sitelinkRedirects).toEqual({ enwiki: "Halo 3#ODST" });
  });

  it("throws when a wiki can't be read", async () => {
    const a = makeItem("Q1", "Foo", {}, { sitelinks: { enwiki: "Foo" } });
    const b = makeItem("Q2", "Foo", {}, { sitelinks: { enwiki: "Bar" } });
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("", { status: 503 }));
    await expect(attachLiveSitelinkRedirects(a, b, fetchImpl)).rejects.toThrow(/HTTP 503/);
  });
});
