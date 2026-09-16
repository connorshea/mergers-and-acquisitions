import { readFileSync } from "node:fs";
import { defineSeed } from "void/seed";
import { externalIdRows, mapDumpGame, primaryLabel, primaryType } from "../src/lib/wikidata.ts";
import type { WikidataDump } from "../src/lib/wikidata.ts";

// Seed the local DB from a Wikidata video-game dump (script/dump_wikidata_games.rb
// in vglist). The dump is large (~250MB, 172k games) and uncommitted; it lives
// under seed-data/ by default.
//
//   void db seed                      # seed everything at WIKIDATA_DUMP_PATH
//   SEED_LIMIT=2000 void db seed      # quick slice for iterating locally
//   WIKIDATA_DUMP_PATH=… void db seed # point at a different dump
const DUMP_PATH = process.env.WIKIDATA_DUMP_PATH ?? "seed-data/wikidata_games.json";
const LIMIT = process.env.SEED_LIMIT ? Number(process.env.SEED_LIMIT) : Infinity;

// SQLite caps bound parameters per statement; size batches from the column
// count to stay comfortably under it.
function batchSize(columns: number): number {
  return Math.max(1, Math.floor(900 / columns));
}

async function insertInBatches<T>(
  rows: T[],
  columns: number,
  insert: (chunk: T[]) => Promise<unknown>,
) {
  const size = batchSize(columns);
  for (let i = 0; i < rows.length; i += size) {
    await insert(rows.slice(i, i + size));
  }
}

export default defineSeed<typeof import("./schema")>(async ({ db, schema }) => {
  const dump = JSON.parse(readFileSync(DUMP_PATH, "utf8")) as WikidataDump;
  const games = Number.isFinite(LIMIT) ? dump.games.slice(0, LIMIT) : dump.games;
  console.log(`Seeding ${games.length} of ${dump.game_count} games from ${DUMP_PATH}`);

  const itemRows: (typeof schema.items.$inferInsert)[] = [];
  const idRows: (typeof schema.externalIds.$inferInsert)[] = [];

  for (const game of games) {
    const item = mapDumpGame(game);
    itemRows.push({
      qid: item.id,
      primaryLabel: primaryLabel(item) ?? null,
      primaryType: primaryType(item) ?? null,
      data: item,
    });
    for (const row of externalIdRows(item)) {
      idRows.push({ qid: item.id, property: row.property, value: row.value });
    }
  }

  await insertInBatches(itemRows, 4, (chunk) => db.insert(schema.items).values(chunk));
  await insertInBatches(idRows, 3, (chunk) => db.insert(schema.externalIds).values(chunk));

  console.log(`Inserted ${itemRows.length} items and ${idRows.length} external ids`);
});
