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
export const CONVERTER_OUTPUTS = ["de985f695de771a2287e8af38bd1e307161a062c"] as const;

export const CONVERTER_VERSION = CONVERTER_OUTPUTS.length;
