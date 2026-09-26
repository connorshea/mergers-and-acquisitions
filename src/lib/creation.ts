// Reading an item's creation (its first revision, see server/item-creations.ts)
// for the detail page: which tool made it, and whether the creator looks like a
// bot or a temporary account. DOM-free so it can be unit-tested.
import type { ItemCreation } from "./api-types.ts";

/** Items (and their histories) live on Wikidata proper, even when edits go to a test wiki. */
export const WIKIDATA_ORIGIN = "https://www.wikidata.org";

/** A tool that created an item, with a link to its batch when there is one. */
export interface CreationTool {
  name: string;
  url?: string;
}

/** OAuth consumer ids (the "OAuth CID: N" tag) worth naming. */
const OAUTH_CONSUMERS: Record<string, string> = {
  "1776": "QuickStatements",
};

/** EditGroups tool codes (the `b/<code>/<id>` in its batch links). */
const EDITGROUPS_TOOLS: Record<string, string> = {
  OR: "OpenRefine",
  QSv2: "QuickStatements",
  QSv2T: "QuickStatements",
};

/**
 * The tool behind a creation, from its edit summary and change tags. The most
 * specific signal wins: a batch link over a hashtag, a hashtag over a tag.
 * Null for a creation that names no tool.
 */
export function creationTool(c: Pick<ItemCreation, "comment" | "tags">): CreationTool | null {
  const comment = c.comment ?? "";
  const tags = c.tags;
  let m: RegExpMatchArray | null;

  if ((m = comment.match(/toollabs:quickstatements\/#\/batch\/(\d+)/)))
    return {
      name: `QuickStatements batch #${m[1]}`,
      url: `https://quickstatements.toolforge.org/#/batch/${m[1]}`,
    };
  if ((m = comment.match(/toollabs:qs-dev\/batch\/(\d+)/)))
    return {
      name: `QuickStatements batch #${m[1]}`,
      url: `https://qs-dev.toolforge.org/batch/${m[1]}`,
    };
  if ((m = comment.match(/#temporary_batch_(\d+)/)))
    return {
      name: "QuickStatements (unsaved batch)",
      url: `https://editgroups.toolforge.org/b/QSv2T/${m[1]}/`,
    };
  if ((m = comment.match(/toollabs:editgroups\/b\/([^/|\]\s]+)\/([^/|\]\s]+)/)))
    return {
      name: `${EDITGROUPS_TOOLS[m[1]] ?? m[1]} batch`,
      url: `https://editgroups.toolforge.org/b/${m[1]}/${m[2]}/`,
    };
  if (/#quickstatements\b/i.test(comment)) return { name: "QuickStatements" };
  if (tags.some((t) => t.startsWith("openrefine"))) return { name: "OpenRefine" };
  if ((m = comment.match(/Item duplicated from (Q\d+)/)))
    return { name: `a copy of ${m[1]}`, url: `${WIKIDATA_ORIGIN}/wiki/${m[1]}` };
  if ((m = comment.match(/via ([\w' -]+?) gadget/))) return { name: `${m[1]} gadget` };
  if (tags.includes("client-linkitem-change")) return { name: "Wikipedia's “Add links”" };
  if (/#mix'?n'?match|mix-n-match/i.test(comment)) return { name: "Mix'n'match" };
  if (/#petscan\b/i.test(comment)) return { name: "PetScan" };
  for (const t of tags) {
    if ((m = t.match(/^OAuth CID: (\d+)$/)))
      return { name: OAUTH_CONSUMERS[m[1]] ?? `OAuth app #${m[1]}` };
  }
  if ((m = comment.match(/(?:^|\s)#([A-Za-z][\w'-]*)/))) return { name: `#${m[1]}` };
  if (tags.includes("wikidata-ui")) return { name: "the Wikidata UI" };
  return null;
}

/**
 * In the bot group, or named like a bot ("Pi bot", "KaleemBot", "FooBOT").
 * The name check catches retired or unflagged bots, but only a separate or
 * capitalized "bot" so names like "Talbot" don't match.
 */
export function looksLikeBot(c: Pick<ItemCreation, "userName" | "userIsBot">): boolean {
  if (c.userIsBot) return true;
  const name = c.userName ?? "";
  return /(?:^|[\s_-])bot$/i.test(name) || /(?:Bot|BOT)$/.test(name);
}

/** A temporary account ("~2026-46215-53"), MediaWiki's replacement for IP editing. */
export function isTemporaryAccount(name: string | null): boolean {
  return name !== null && /^~\d/.test(name);
}

/** Link to the creator's user page (their contributions, for a logged-out editor). */
export function creatorUrl(c: Pick<ItemCreation, "userName" | "userId">): string | null {
  if (!c.userName) return null;
  const page = c.userId ? `User:${c.userName}` : `Special:Contributions/${c.userName}`;
  return `${WIKIDATA_ORIGIN}/wiki/${encodeURIComponent(page.replaceAll(" ", "_")).replaceAll("%3A", ":").replaceAll("%2F", "/")}`;
}

/** The creating revision itself. */
export function creationRevisionUrl(c: Pick<ItemCreation, "revId">): string {
  return `${WIKIDATA_ORIGIN}/w/index.php?oldid=${c.revId}`;
}

/** The item's full history. */
export function historyUrl(qid: string): string {
  return `${WIKIDATA_ORIGIN}/w/index.php?title=${qid}&action=history`;
}

/** "2024-03-19 22:48:42" (UTC) → a Date. */
export function creationDate(c: Pick<ItemCreation, "createdAt">): Date {
  return new Date(`${c.createdAt.replace(" ", "T")}Z`);
}

/**
 * A username as MediaWiki stores it: trimmed, underscores as spaces, runs of
 * spaces collapsed, first letter upper-cased. So "some_user" matches the stored
 * "Some user". IP addresses and temporary accounts ("~2025-…") pass through.
 */
export function normalizeUserName(name: string): string {
  const s = name.replace(/_/g, " ").replace(/\s+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const compactCount = new Intl.NumberFormat("en", { notation: "compact" });

/**
 * A user's edit count for display: exact below 1,000, compact above it
 * ("590,768" → "591K", "1,004,200" → "1M"), where the exact figure is noise.
 */
export function formatEditCount(n: number): string {
  return n < 1000 ? n.toLocaleString("en") : compactCount.format(n);
}
