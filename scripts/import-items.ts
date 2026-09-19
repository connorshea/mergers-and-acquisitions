// Import specific Wikidata items by QID into the `items` + `external_ids`
// tables, so the hunt can score them without a full re-seed. Unlike db/seed.ts
// (which reads the bulk vglist dump), this fetches each entity live from
// Wikidata's Special:EntityData and maps it through the same mapDumpGame adapter
// the seed uses, so the stored `items.data` shape is identical: labels +
// statements only (descriptions/aliases/sitelinks stay empty and are enriched
// by the sync jobs, exactly as for seeded items).
//
// Writes are idempotent: an item's row is upserted and its external_ids are
// rebuilt wholesale (delete-then-insert), matching the schema's "rebuilt for an
// item on each sync" contract. Needs a reachable DB (local MariaDB / Toolforge).
//
//   node scripts/import-items.ts Q133634 Q10423793
//   pnpm run job:hunt          # then score — see if the pair surfaces
import { eq } from "drizzle-orm";
import { db, pool } from "../server/db.ts";
import { externalIds, items } from "../db/schema.ts";
import { externalIdRows, mapDumpGame, primaryLabel, primaryType } from "../src/lib/wikidata.ts";
import type { DumpGame, DumpValue } from "../src/lib/wikidata.ts";

const ENTITYDATA = "https://www.wikidata.org/wiki/Special:EntityData";
const UA = "mergers-and-acquisitions/0.1 (https://github.com/connorshea; single-item importer)";
const PAUSE_MS = 1000; // be polite to the API between fetches
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const TIME_XSD = "http://www.w3.org/2001/XMLSchema#dateTime";
const QTY_XSD = "http://www.w3.org/2001/XMLSchema#decimal";

/** Best-rank truthy values, mirroring the dump's `wdt:` SPARQL: preferred if any
 * exist, else normal; deprecated dropped. */
function bestRank(claims: WdClaim[]): WdClaim[] {
  if (claims.some((c) => c.rank === "preferred"))
    return claims.filter((c) => c.rank === "preferred");
  return claims.filter((c) => c.rank !== "deprecated");
}

/** One Wikidata claim value → the dump's value-node shape, or null to drop it
 * (non-value snaks and datatypes the dump doesn't carry, e.g. media/coords). */
function toDumpValue(snak: WdSnak, datatype: string): DumpValue | null {
  if (snak.snaktype !== "value" || !snak.datavalue) return null;
  const v = snak.datavalue.value as Record<string, string> | string;
  switch (datatype) {
    case "wikibase-item":
    case "wikibase-property":
      return { type: "entity", value: (v as Record<string, string>).id };
    case "url":
      return { type: "uri", value: v as string };
    case "time":
      return { type: "literal", value: (v as Record<string, string>).time, datatype: TIME_XSD };
    case "quantity":
      return { type: "literal", value: (v as Record<string, string>).amount, datatype: QTY_XSD };
    case "monolingualtext":
      return {
        type: "literal",
        value: (v as Record<string, string>).text,
        lang: (v as Record<string, string>).language,
      };
    case "external-id":
      return { type: "literal", value: v as string };
    case "string":
      // Force plain-string classification (a bare literal would otherwise be
      // shape-classified as an external id); `lang` makes literalType() pick
      // "string". The value never enters external_ids blocking as an id.
      return { type: "literal", value: v as string, lang: "und" };
    default:
      return null; // commonsMedia, globe-coordinate, … — not in the dump
  }
}

/** Fetch an entity and convert it into a DumpGame (the mapDumpGame input). */
async function fetchDumpGame(qid: string): Promise<DumpGame> {
  const res = await fetch(`${ENTITYDATA}/${qid}.json`, {
    headers: { "User-Agent": UA, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`GET ${qid} -> ${res.status}`);
  const entity = ((await res.json()) as { entities: Record<string, WdEntity> }).entities[qid];
  if (!entity) throw new Error(`${qid}: missing from EntityData response (redirect?)`);

  const properties: Record<string, DumpValue[]> = {};
  for (const [pid, claims] of Object.entries(entity.claims ?? {})) {
    const dt = claims[0]?.mainsnak.datatype;
    if (!dt) continue;
    const values: DumpValue[] = [];
    for (const c of bestRank(claims)) {
      const node = toDumpValue(c.mainsnak, dt);
      if (!node) continue;
      // "identifier shared with" (P4070) qualifier → shared_with, so the scorer
      // discounts an id explicitly declared to span both items.
      const shared = (c.qualifiers?.P4070 ?? [])
        .filter((q) => q.snaktype === "value" && q.datavalue)
        .map((q) => (q.datavalue!.value as Record<string, string>).id);
      if (shared.length) node.shared_with = shared;
      values.push(node);
    }
    if (values.length) properties[pid] = values;
  }

  return {
    wikidata_id: Number(qid.slice(1)),
    qid,
    label: entity.labels?.en?.value ?? entity.labels?.mul?.value ?? null,
    en_label: entity.labels?.en?.value ?? null,
    mul_label: entity.labels?.mul?.value ?? null,
    properties,
  };
}

async function importItem(qid: string): Promise<void> {
  const item = mapDumpGame(await fetchDumpGame(qid));

  await db
    .insert(items)
    .values({
      qid: item.id,
      primaryLabel: primaryLabel(item) ?? null,
      primaryType: primaryType(item) ?? null,
      data: item,
    })
    .onDuplicateKeyUpdate({
      set: {
        primaryLabel: primaryLabel(item) ?? null,
        primaryType: primaryType(item) ?? null,
        data: item,
        lastSyncedAt: new Date().toISOString().slice(0, 19).replace("T", " "),
      },
    });

  // Rebuild this item's external_ids wholesale (dedupe on the unique key).
  await db.delete(externalIds).where(eq(externalIds.qid, item.id));
  const seen = new Set<string>();
  const rows = externalIdRows(item)
    .filter((r) => {
      const key = `${r.property} ${r.value}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((r) => ({ qid: item.id, property: r.property, value: r.value }));
  if (rows.length) await db.insert(externalIds).values(rows);

  console.log(
    `imported ${item.id} "${primaryLabel(item) ?? "?"}" (P31 ${primaryType(item) ?? "?"}), ${rows.length} external ids`,
  );
}

// ---------- minimal Wikidata entity types ----------
interface WdSnak {
  snaktype: string;
  datatype: string;
  datavalue?: { value: unknown; type: string };
}
interface WdClaim {
  rank: string;
  mainsnak: WdSnak;
  qualifiers?: Record<string, WdSnak[]>;
}
interface WdEntity {
  labels?: Record<string, { value: string }>;
  claims?: Record<string, WdClaim[]>;
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
