import { describe, expect, it } from "vite-plus/test";
import {
  creationTool,
  creatorUrl,
  formatEditCount,
  isTemporaryAccount,
  looksLikeBot,
  normalizeUserName,
} from "./creation.ts";

const tool = (comment: string | null, tags: string[] = []) => creationTool({ comment, tags });

describe("creationTool", () => {
  it("links a QuickStatements batch", () => {
    expect(
      tool(
        "/* wbeditentity-create-item:0| */ [[:toollabs:quickstatements/#/batch/251234|batch #251234]]",
        ["OAuth CID: 1776"],
      ),
    ).toEqual({
      name: "QuickStatements batch #251234",
      url: "https://quickstatements.toolforge.org/#/batch/251234",
    });
    expect(tool("QuickStatements 3.0 [[:toollabs:qs-dev/batch/88|batch #88]]")).toEqual({
      name: "QuickStatements batch #88",
      url: "https://qs-dev.toolforge.org/batch/88",
    });
  });

  it("links an unsaved QuickStatements batch through EditGroups", () => {
    expect(
      tool("/* wbeditentity-create-item:0| */ #quickstatements; #temporary_batch_1758700000123"),
    ).toEqual({
      name: "QuickStatements (unsaved batch)",
      url: "https://editgroups.toolforge.org/b/QSv2T/1758700000123/",
    });
  });

  it("links an EditGroups batch, naming the tool when it's known", () => {
    expect(
      tool("add scholarly article ([[:toollabs:editgroups/b/OR/e9164d2e04b|details]])", [
        "openrefine-3.8",
      ]),
    ).toEqual({
      name: "OpenRefine batch",
      url: "https://editgroups.toolforge.org/b/OR/e9164d2e04b/",
    });
    expect(tool("([[:toollabs:editgroups/b/XYZ/abc|details]])")?.name).toBe("XYZ batch");
  });

  it("recognizes tools from hashtags and tags", () => {
    expect(tool("#quickstatements")).toEqual({ name: "QuickStatements" });
    expect(tool("Setting labels", ["openrefine"])).toEqual({ name: "OpenRefine" });
    expect(tool("#mix'n'match")).toEqual({ name: "Mix'n'match" });
    expect(tool("", ["client-linkitem-change"])).toEqual({ name: "Wikipedia's “Add links”" });
    expect(tool("", ["OAuth CID: 1776"])).toEqual({ name: "QuickStatements" });
    expect(tool("", ["OAuth CID: 1798"])).toEqual({ name: "OAuth app #1798" });
    expect(tool("Foo, a video game", ["wikidata-ui"])).toEqual({ name: "the Wikidata UI" });
    expect(tool("imported #zotero")).toEqual({ name: "#zotero" });
  });

  it("notes a duplicated item and gadgets", () => {
    expect(tool("Item duplicated from Q12345")).toEqual({
      name: "a copy of Q12345",
      url: "https://www.wikidata.org/wiki/Q12345",
    });
    expect(tool("Creating new author item (via author_strings gadget)")).toEqual({
      name: "author_strings gadget",
    });
  });

  it("is null when nothing names a tool", () => {
    expect(tool("/* wbeditentity-create-item:0| */ Setting labels")).toBeNull();
    expect(tool(null)).toBeNull();
    // A section anchor in a link isn't a hashtag.
    expect(tool("Creating item from [[en:Foo#History]]")).toBeNull();
  });
});

describe("looksLikeBot", () => {
  it("trusts the bot group and bot-style names", () => {
    expect(looksLikeBot({ userName: "Someone", userIsBot: true })).toBe(true);
    expect(looksLikeBot({ userName: "Pi bot", userIsBot: false })).toBe(true);
    expect(looksLikeBot({ userName: "KaleemBot", userIsBot: false })).toBe(true);
    expect(looksLikeBot({ userName: "RobertgarrigosBOT", userIsBot: false })).toBe(true);
    expect(looksLikeBot({ userName: "Talbot", userIsBot: false })).toBe(false);
    expect(looksLikeBot({ userName: null, userIsBot: false })).toBe(false);
  });
});

describe("creator links", () => {
  it("links a user page, or contributions for a logged-out editor", () => {
    expect(creatorUrl({ userName: "Andre Engels", userId: 5 })).toBe(
      "https://www.wikidata.org/wiki/User:Andre_Engels",
    );
    expect(creatorUrl({ userName: "192.0.2.1", userId: null })).toBe(
      "https://www.wikidata.org/wiki/Special:Contributions/192.0.2.1",
    );
    expect(creatorUrl({ userName: null, userId: null })).toBeNull();
    expect(isTemporaryAccount("~2026-46215-53")).toBe(true);
    expect(isTemporaryAccount("Andre Engels")).toBe(false);
  });
});

describe("normalizeUserName", () => {
  it("matches MediaWiki's stored form", () => {
    expect(normalizeUserName("  some_user  name ")).toBe("Some user name");
    expect(normalizeUserName("Andre Engels")).toBe("Andre Engels");
    expect(normalizeUserName("192.0.2.1")).toBe("192.0.2.1");
    expect(normalizeUserName("~2026-46215-53")).toBe("~2026-46215-53");
  });
});

describe("formatEditCount", () => {
  it("is exact below 1,000", () => {
    expect(formatEditCount(0)).toBe("0");
    expect(formatEditCount(905)).toBe("905");
  });

  it("is compact from 1,000 up", () => {
    expect(formatEditCount(1000)).toBe("1K");
    expect(formatEditCount(1234)).toBe("1.2K");
    expect(formatEditCount(590_768)).toBe("591K");
    expect(formatEditCount(1_004_200)).toBe("1M");
    expect(formatEditCount(12_345_678)).toBe("12M");
    expect(formatEditCount(1_200_000_000)).toBe("1.2B");
  });
});
