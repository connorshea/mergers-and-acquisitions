// Adapter from Wikidata dump/query value nodes into the simplified `Item` model
// that the comparison UI and `scoreCandidate` consume. DOM-free so routes,
// queues, crons, and seed scripts can all import it.
//
// The vglist dump (script/dump_wikidata_games.rb) and a live QLever query both
// emit the same three value-node shapes, so classification lives here once. The
// important constraint: neither source carries a Wikidata *property datatype*,
// so external-id vs plain string cannot be told apart from the value alone — we
// key that off the property id via EXTERNAL_ID_PROPERTIES below.

import type { Item, Value, ValueType } from "./compare";

// ---------- dump / query wire format ----------

export interface DumpValueEntity {
  type: "entity";
  value: string; // "Q123"
}
export interface DumpValueLiteral {
  type: "literal";
  value: string;
  datatype?: string; // raw XSD datatype IRI, when the endpoint provided one
  lang?: string; // BCP-47 tag, when present
}
export interface DumpValueUri {
  type: "uri";
  value: string; // full non-entity IRI
}
export type DumpValue = DumpValueEntity | DumpValueLiteral | DumpValueUri;

export interface DumpGame {
  wikidata_id: number;
  qid: string;
  label: string | null; // en_label ?? mul_label
  en_label: string | null;
  mul_label: string | null;
  properties: Record<string, DumpValue[]>; // Pxxx -> values, truthy wdt: claims only
}

export interface WikidataDump {
  generated_at: string;
  endpoint: string;
  games: DumpGame[];
  game_count: number;
}

// ---------- value classification ----------

// The dump/query carries no Wikidata property datatype, so we classify literals
// by their *shape*, which is unambiguous in practice. Measured over ~1.18M
// values from the real video-game dump: literals are either time (xsd:dateTime),
// quantity (xsd:decimal), monolingual text (a language tag), or — 93% of them —
// a bare literal with neither, which is an external identifier. Most genuine
// string-datatype properties landing in "external-id" is harmless for shared-id
// blocking, but a few plain-string properties carry values that *look* like an
// id and collide across unrelated games (see NON_ID_STRING_PROPS); those are
// pinned to "string" by property id so they never count as a shared identifier.
const TIME_XSD = ["dateTime", "date", "gYear", "gYearMonth", "gMonthDay"];
const QUANTITY_XSD = ["decimal", "double", "float", "integer", "int", "long", "nonNegativeInteger"];

// Plain-string (not ExternalId) Wikidata properties whose bare-literal values
// would otherwise be shape-classified as external identifiers and produce false
// matches. P348 (software version identifier) is the canonical case: two
// unrelated games both at "1.0"/"1.9" would look like they share an id (e.g.
// Doom Q189784 and its port POOM Q130723192, both P348="1.9"). Keep this list
// to genuine string-datatype props that collide in practice; the datatype-aware
// eval path already classifies these correctly and doesn't rely on it.
const NON_ID_STRING_PROPS = new Set<string>([
  "P348", // software version identifier
]);

function literalType(node: DumpValueLiteral, pid?: string): ValueType {
  const xsd = node.datatype?.split("#")[1] ?? "";
  if (TIME_XSD.includes(xsd)) return "time";
  if (QUANTITY_XSD.includes(xsd)) return "quantity";
  if (node.lang) return "string"; // monolingual text (e.g. title P1476, native label P1705)
  if (pid && NON_ID_STRING_PROPS.has(pid)) return "string"; // known plain-string prop, not an id
  return "external-id"; // bare literal — an identifier in practice
}

// A Wikidata "somevalue" (unknown value) snak is a blank node; over SPARQL/QLever
// it comes back as a skolem IRI under `/.well-known/genid/`. It is not a real URL
// — treat it as an unknown value, not a link. (A "novalue" snak yields no `wdt:`
// binding at all, so it never reaches the dump path.)
export const GENID_URI_RE = /\/\.well-known\/genid\//;

/**
 * Classify a single dump/query value node into the `Item` value model. Pass the
 * value's property id so known plain-string properties (NON_ID_STRING_PROPS)
 * aren't mistaken for external identifiers by their value shape.
 */
export function classifyValue(node: DumpValue, pid?: string): Value {
  switch (node.type) {
    case "entity":
      return { type: "item", value: node.value };
    case "uri":
      return GENID_URI_RE.test(node.value)
        ? { type: "somevalue", value: "" }
        : { type: "url", value: node.value };
    default:
      return { type: literalType(node, pid), value: node.value };
  }
}

// ---------- dump -> Item ----------

/**
 * Map one dumped game into an `Item`. The dump only carries labels (en/mul) and
 * truthy `wdt:` statement values — descriptions, aliases, and sitelinks are not
 * present and stay empty here; the live sync path enriches those separately.
 * Item-valued statements have no resolved `label` (the dump omits referenced
 * items' labels); a later pass can backfill from the `items` table.
 */
export function mapDumpGame(game: DumpGame): Item {
  const labels: Record<string, string> = {};
  if (game.en_label) labels.en = game.en_label;
  if (game.mul_label) labels.mul = game.mul_label;

  const statements: Record<string, Value[]> = {};
  for (const [property, nodes] of Object.entries(game.properties)) {
    const values = nodes.map((n) => classifyValue(n, property));
    if (values.length > 0) statements[property] = values;
  }

  return {
    id: game.qid,
    labels,
    descriptions: {},
    aliases: {},
    sitelinks: {},
    statements,
  };
}

// ---------- derived rows for the DB ----------

/** First `P31` (instance of) item value, e.g. "Q7889" — the denormalized primary type. */
export function primaryType(item: Item): string | undefined {
  return item.statements.P31?.find((v) => v.type === "item")?.value;
}

/** Best display label: English, then `mul`, then any other language. */
export function primaryLabel(item: Item): string | undefined {
  return item.labels.en ?? item.labels.mul ?? Object.values(item.labels)[0];
}

/** External-id `(property, value)` rows for the `external_ids` blocking table. */
export function externalIdRows(item: Item): { property: string; value: string }[] {
  const rows: { property: string; value: string }[] = [];
  for (const [property, values] of Object.entries(item.statements)) {
    for (const v of values) {
      if (v.type === "external-id") rows.push({ property, value: v.value });
    }
  }
  return rows;
}

/**
 * QIDs this item references as item-valued statement values (genre, platform,
 * developer, instance of, …). These are the entities the comparison view shows
 * by name, so the entity-label sync fetches labels for exactly this set (unioned
 * across all items) rather than asking Wikidata to derive it — see
 * server/entity-labels-sync.ts.
 */
export function referencedItemQids(item: Item): string[] {
  const qids: string[] = [];
  for (const values of Object.values(item.statements)) {
    for (const v of values) {
      if (v.type === "item") qids.push(v.value);
    }
  }
  return qids;
}
