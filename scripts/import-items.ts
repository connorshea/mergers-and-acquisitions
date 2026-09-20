// Import specific Wikidata items by QID into the `items` + `external_ids`
// tables, so the hunt can score them without a full dump pass. Each entity is
// fetched live from Special:EntityData and stored through the same
// entityToItem + upsertItems path the dump import uses (server/dump-import.ts),
// so the stored `items.data` shape is identical.
//
// Writes are idempotent: an item's row is upserted and its external_ids are
// rebuilt wholesale. Needs a reachable DB (local MariaDB / Toolforge).
//
//   node scripts/import-items.ts Q133634 Q10423793
//   pnpm run job:hunt          # then score — see if the pair surfaces
import { db, pool } from "../server/db.ts";
import { upsertItems } from "../server/dump-import.ts";
import { externalIds } from "../db/schema.ts";
import { eq } from "drizzle-orm";
import { primaryLabel, primaryType } from "../src/lib/wikidata.ts";
import { type Entity, entityToItem } from "../src/lib/wikibase.ts";

const ENTITYDATA = "https://www.wikidata.org/wiki/Special:EntityData";
const UA = "mergers-and-acquisitions/0.1 (https://github.com/connorshea; single-item importer)";
const PAUSE_MS = 1000; // be polite to the API between fetches
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchEntity(qid: string): Promise<Entity> {
  const res = await fetch(`${ENTITYDATA}/${qid}.json`, {
    headers: { "User-Agent": UA, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`GET ${qid} -> ${res.status}`);
  const entity = ((await res.json()) as { entities: Record<string, Entity> }).entities[qid];
  if (!entity) throw new Error(`${qid}: missing from EntityData response (redirect?)`);
  return entity;
}

async function importItem(qid: string): Promise<void> {
  const item = entityToItem(await fetchEntity(qid));
  await upsertItems([item]);
  const ids = await db.select().from(externalIds).where(eq(externalIds.qid, item.id));
  console.log(
    `imported ${item.id} "${primaryLabel(item) ?? "?"}" (P31 ${primaryType(item) ?? "?"}), ${ids.length} external ids`,
  );
}

async function main() {
  const qids = process.argv.slice(2).filter((a) => /^Q\d+$/.test(a));
  if (qids.length === 0) throw new Error("usage: node scripts/import-items.ts Qxxx [Qxxx …]");
  for (let i = 0; i < qids.length; i++) {
    await importItem(qids[i]);
    if (i < qids.length - 1) await sleep(PAUSE_MS);
  }
}

main()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error("import failed", err);
    await pool.end().catch(() => {});
    process.exit(1);
  });
