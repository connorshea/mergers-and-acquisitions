// Which version of the entity → row conversion (entityToItem, externalIdRows,
// and the row preparation in server/dump-import.ts) an `items` row was written
// by. The dump import skips an item without parsing it when the dump has the
// revision the row was converted from *and* the row's version is current, so a
// conversion change that isn't matched by a new version here would leave
// unedited items converted the old way indefinitely.
//
// The version is derived from this append-only list of output hashes, so it
// can't be bumped (or forgotten) on its own: server/converter-version.test.ts
// converts the fixture lines in test/fixtures/converter-golden.jsonl and fails
// when their hash isn't the last entry, with the new hash to append. Never edit
// or remove an entry; only append. Adding fixture lines changes the hash too:
// append then as well, which costs one import that parses every item.
export const CONVERTER_OUTPUTS = [
  "de985f695de771a2287e8af38bd1e307161a062c",
  // Year/month-precision dates zeroed (#145); its fixtures held pre-zeroed times,
  // so the hash didn't move then — the Q107532735 fixture line moves it now.
  "1414b22fcbbf537d7308d7a6f5b5f41ee05440d0",
  // Globe coordinates stored as a `coordinate` value instead of a "lat,lon" string (#191).
  "67bcc726f2deb6e0003a1252433338bba960aa96",
  // Musical notation (P6670) stored as a `musical-notation` value instead of a string.
  "c3f167c9205618016c2efd6eaff84e7b2be7dccc",
  // Class and place values stored in `item_values` (and covered by the item
  // hash, so the next import writes every item's rows: the backfill).
  "bb9105c9d05436375a1532596f0e3de73acecf1a",
  // Decade/century/millennium dates keep their precision (`timePrecision`), so
  // "20th century" no longer reads as 1901.
  "f4313f240d70f67fd83e00b65d9bb1686f362858",
] as const;

export const CONVERTER_VERSION = CONVERTER_OUTPUTS.length;

// The converter version since which every write of an item also writes its
// `item_values` rows, as they stand now (ITEM_VALUE_PROPS in
// src/lib/wikidata.ts). An item synced at an older version may have none, so
// the syncs that read `item_values` refuse to run while any such item is left
// (server/class-ancestors.ts `collectItemValues`). Move it to the new
// CONVERTER_VERSION whenever ITEM_VALUE_PROPS changes what the table holds.
export const ITEM_VALUES_VERSION = 5;
