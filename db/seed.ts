// Seed the DB from a Wikidata video-game dump (script/dump_wikidata_games.rb in
// vglist). The dump is large (~250MB, 172k games) and uncommitted; it lives
// under seed-data/ by default. Intended for a fresh/empty DB.
//
//   pnpm seed                       # seed everything at WIKIDATA_DUMP_PATH
//   SEED_LIMIT=2000 pnpm seed       # quick slice for iterating locally
//   WIKIDATA_DUMP_PATH=… pnpm seed  # point at a different dump
import { readFileSync } from "node:fs";
import { db } from "../server/db";
import { externalIds, items } from "./schema";
import { externalIdRows, mapDumpGame, primaryLabel, primaryType } from "../src/lib/wikidata";
import type { WikidataDump } from "../src/lib/wikidata";

const DUMP_PATH = process.env.WIKIDATA_DUMP_PATH ?? "seed-data/wikidata_games.json";
const LIMIT = process.env.SEED_LIMIT ? Number(process.env.SEED_LIMIT) : Infinity;

// MariaDB caps params per statement (65535) and packet size (max_allowed_packet).
// The item rows carry a large JSON blob each, so keep those batches modest.
const ITEM_BATCH = 500;
const ID_BATCH = 2000;

async function insertInBatches<T>(
  rows: T[],
  size: number,
  insert: (chunk: T[]) => Promise<unknown>,
) {
  for (let i = 0; i < rows.length; i += size) {
    await insert(rows.slice(i, i + size));
  }
}

async function main() {
  const dump = JSON.parse(readFileSync(DUMP_PATH, "utf8")) as WikidataDump;
  const games = Number.isFinite(LIMIT) ? dump.games.slice(0, LIMIT) : dump.games;
  console.log(`Seeding ${games.length} of ${dump.game_count} games from ${DUMP_PATH}`);

  const itemRows: (typeof items.$inferInsert)[] = [];
  const idRows: (typeof externalIds.$inferInsert)[] = [];

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

  await insertInBatches(itemRows, ITEM_BATCH, (chunk) => db.insert(items).values(chunk));
  await insertInBatches(idRows, ID_BATCH, (chunk) => db.insert(externalIds).values(chunk));

  console.log(`Inserted ${itemRows.length} items and ${idRows.length} external ids`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("seed failed", err);
    process.exit(1);
  });
