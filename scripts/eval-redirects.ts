// Resolved sitelink redirects for an eval pair, kept beside its entity blobs as
// `sitelink-redirects.json`. The blobs carry sitelink badges but not where a
// redirect points, which production learns from the Wiki Replicas / the wikis'
// Action API (Item.sitelinkRedirects). Recording it lets the offline scorer
// exercise the same redirect-to-partner logic.
//
// Resolved against the wikis *now*, not at the blobs' revisions — page history
// isn't pinned — so `checkedAt` records when. Only the pages behind a same-wiki
// sitelink clash are resolved (the only ones production resolves), and a file
// is only written once one of them is a redirect.
//
// Recorded entries are never overwritten or dropped: once the pair is merged or
// the redirect is cleaned up, the wiki no longer says what it said when the
// pair was captured, and the eval should keep scoring that state. A re-check
// only adds redirects not recorded yet; delete the file to start over.

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Item } from "../src/lib/compare.ts";
import { attachLiveSitelinkRedirects } from "../server/live-sitelinks.ts";
import { sitelinkClashes } from "../server/sitelink-overlay.ts";

export const REDIRECTS_FILE = "sitelink-redirects.json";

interface RedirectsFile {
  /** When an entry was last added (existing entries keep their values). */
  checkedAt: string;
  /** QID → (wiki → target, "Title#Section" for a section, "prefix:Title" off-wiki). */
  redirects: Record<string, Record<string, string | null>>;
}

/** The pair directory's recorded redirects, or null when there's no file. */
async function readRedirects(dir: string): Promise<RedirectsFile | null> {
  try {
    return JSON.parse(await readFile(join(dir, REDIRECTS_FILE), "utf8")) as RedirectsFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Resolve the pair's clashing sitelinks against their wikis and add any
 * redirect not already recorded to the pair directory's redirects file,
 * keeping every recorded entry as it is. Returns the file (null when nothing
 * is recorded) and how many entries were added. Throws when a wiki can't be
 * read; the file is left as it was.
 */
export async function recordRedirects(
  dir: string,
  a: Item,
  b: Item,
): Promise<{ file: RedirectsFile | null; added: number }> {
  const existing = await readRedirects(dir);
  if (sitelinkClashes(a, b).length === 0) return { file: existing, added: 0 };
  // Resolve on copies: the callers' items stay as the blobs say.
  const [ca, cb] = [{ ...a }, { ...b }];
  await attachLiveSitelinkRedirects(ca, cb);
  const redirects = structuredClone(existing?.redirects ?? {});
  let added = 0;
  for (const item of [ca, cb]) {
    for (const [wiki, target] of Object.entries(item.sitelinkRedirects ?? {})) {
      const recorded = (redirects[item.id] ??= {});
      if (wiki in recorded) continue;
      recorded[wiki] = target;
      added++;
    }
  }
  if (added === 0) return { file: existing, added };
  const file: RedirectsFile = { checkedAt: new Date().toISOString().slice(0, 10), redirects };
  await writeFile(join(dir, REDIRECTS_FILE), JSON.stringify(file, null, 2) + "\n");
  return { file, added };
}

/** Overlay a pair directory's recorded redirects onto its items, if any. */
export async function applyRedirects(dir: string, ...items: Item[]): Promise<void> {
  const file = await readRedirects(dir);
  if (!file) return;
  for (const item of items) {
    const redirects = file.redirects[item.id];
    if (redirects && Object.keys(redirects).length > 0) item.sitelinkRedirects = redirects;
  }
}
