import { describe, expect, it } from "vite-plus/test";
import { sitelinkLanguage, sitelinkUrl } from "./wiki.ts";

describe("sitelinkUrl", () => {
  it("links a Wikipedia sitelink, underscoring spaces and escaping the title", () => {
    expect(sitelinkUrl("enwiki", "Loud & Dangerous: Live from Hollywood")).toBe(
      "https://en.wikipedia.org/wiki/Loud_%26_Dangerous:_Live_from_Hollywood",
    );
    expect(sitelinkUrl("enwiki", "Doom (1993 video game)")).toBe(
      "https://en.wikipedia.org/wiki/Doom_(1993_video_game)",
    );
    expect(sitelinkUrl("enwiki", "AC/DC")).toBe("https://en.wikipedia.org/wiki/AC/DC");
  });

  it("handles sister projects and dashed language codes", () => {
    expect(sitelinkUrl("dewikiquote", "Goethe")).toBe("https://de.wikiquote.org/wiki/Goethe");
    expect(sitelinkUrl("frwiktionary", "jeu")).toBe("https://fr.wiktionary.org/wiki/jeu");
    expect(sitelinkUrl("zh_min_nanwiki", "Tâi-oân")).toBe(
      "https://zh-min-nan.wikipedia.org/wiki/T%C3%A2i-o%C3%A2n",
    );
  });

  it("maps the non-language sites", () => {
    expect(sitelinkUrl("commonswiki", "Category:Doom")).toBe(
      "https://commons.wikimedia.org/wiki/Category:Doom",
    );
    expect(sitelinkUrl("mediawikiwiki", "Manual:Hooks")).toBe(
      "https://www.mediawiki.org/wiki/Manual:Hooks",
    );
  });

  it("returns null for a site id it can't place", () => {
    expect(sitelinkUrl("somethingelse", "X")).toBeNull();
  });
});

describe("sitelinkLanguage", () => {
  it("maps a wiki to its language code", () => {
    expect(sitelinkLanguage("eswiki")).toBe("es");
    expect(sitelinkLanguage("dewikiquote")).toBe("de");
    expect(sitelinkLanguage("pt_brwiki")).toBe("pt-br");
    expect(sitelinkLanguage("simplewiki")).toBe("en");
    expect(sitelinkLanguage("nowiki")).toBe("nb");
    expect(sitelinkLanguage("zh_min_nanwiki")).toBe("nan");
  });

  it("has no language for multilingual sites", () => {
    expect(sitelinkLanguage("commonswiki")).toBeNull();
    expect(sitelinkLanguage("wikidatawiki")).toBeNull();
  });
});
