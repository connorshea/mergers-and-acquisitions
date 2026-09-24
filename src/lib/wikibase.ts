// Adapter from Wikibase *entity JSON* (the shape of Special:EntityData,
// wbgetentities, and every line of the wikidatawiki JSON dump) into the
// simplified `Item` model that the comparison UI and `scoreCandidate` consume.
// DOM-free so the dump import job, the single-item importer, and the eval
// script all share one conversion — and therefore one stored `items.data` shape.
//
// Compared with the SPARQL-derived path in wikidata.ts this source is richer:
// every snak carries its property datatype (so external ids are classified
// exactly, not by value shape), time values keep their precision (`+1987-00-00`
// for a year), and descriptions / aliases / sitelinks are present.

import type { Item, Value, ValueType } from "./compare.ts";
import { IDENTIFIER_SHARED_WITH } from "./compare.ts";
import type { PropertyRow } from "./sparql.ts";

// ---------- entity JSON wire types (the subset we read) ----------

export interface Snak {
  snaktype: "value" | "novalue" | "somevalue";
  property: string;
  datatype?: string;
  datavalue?: { type: string; value: unknown };
}

export interface Statement {
  mainsnak: Snak;
  rank: "preferred" | "normal" | "deprecated";
  qualifiers?: Record<string, Snak[]>;
}

export interface Entity {
  /** "item" | "property" | "lexeme" … — first key on every dump line. */
  type?: string;
  id: string;
  /** Property entities only: the property's datatype, e.g. "external-id". */
  datatype?: string;
  labels?: Record<string, { value: string }>;
  descriptions?: Record<string, { value: string }>;
  aliases?: Record<string, { value: string }[]>;
  sitelinks?: Record<string, { title: string; badges?: string[] }>;
  claims?: Record<string, Statement[]>;
}

const termMap = (o?: Record<string, { value: string }>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o ?? {})) out[k] = v.value;
  return out;
};

// ---------- snaks / statements -> Value ----------

/** Convert one snak into a scorer Value. Preserves Wikidata's special snak
 * types: "somevalue" (unknown value) and "novalue" (explicit no value). */
export function snakValue(snak: Snak): Value | null {
  if (snak.snaktype === "somevalue") return { type: "somevalue", value: "" };
  if (snak.snaktype === "novalue") return { type: "novalue", value: "" };
  if (snak.snaktype !== "value" || !snak.datavalue) return null;
  const { type, value } = snak.datavalue;
  switch (type) {
    case "wikibase-entityid":
      return { type: "item", value: (value as { id: string }).id };
    case "time":
      return { type: "time", value: (value as { time: string }).time };
    case "quantity":
      return { type: "quantity", value: (value as { amount: string }).amount };
    case "monolingualtext":
      return { type: "string", value: (value as { text: string }).text };
    case "globecoordinate": {
      const c = value as { latitude: number; longitude: number };
      return { type: "string", value: `${c.latitude},${c.longitude}` };
    }
    case "string": {
      // The one case where the property datatype disambiguates the literal.
      const t: ValueType =
        snak.datatype === "external-id"
          ? "external-id"
          : snak.datatype === "url"
            ? "url"
            : "string";
      return { type: t, value: value as string };
    }
    default:
      return { type: "string", value: String(value) };
  }
}

/**
 * Keep only best-rank statements per property, matching the `wdt:` truthy
 * semantics the SPARQL path sees: deprecated ranks are dropped, and if any
 * preferred-rank statement exists only those are kept, else the normals.
 */
export function bestRank(statements: Statement[]): Statement[] {
  const live = statements.filter((s) => s.rank !== "deprecated");
  const preferred = live.filter((s) => s.rank === "preferred");
  return preferred.length > 0 ? preferred : live;
}

/**
 * Convert one statement into a scorer Value, carrying the QIDs of its
 * "identifier shared with" (P4070) qualifiers as `sharedWith` — the same shape
 * the SPARQL dump path emits, so the scorer's shared-identifier handling sees
 * both sources alike.
 */
export function statementValue(statement: Statement): Value | null {
  const value = snakValue(statement.mainsnak);
  if (!value) return null;
  const sharedWith = (statement.qualifiers?.[IDENTIFIER_SHARED_WITH] ?? [])
    .map((q) => snakValue(q))
    .filter((q): q is Value => q !== null && q.type === "item")
    .map((q) => q.value);
  return sharedWith.length > 0 ? { ...value, sharedWith } : value;
}

/** Best-rank values of one property, as scorer Values. */
export function propertyValues(entity: Entity, pid: string): Value[] {
  return bestRank(entity.claims?.[pid] ?? [])
    .map(statementValue)
    .filter((v): v is Value => v !== null);
}

// ---------- entity -> Item ----------

/** Map one entity into an `Item`: every label/description/alias/sitelink (with
 * its badges), and
 * the best-rank value(s) of every property. */
export function entityToItem(entity: Entity): Item {
  const statements: Record<string, Value[]> = {};
  for (const pid of Object.keys(entity.claims ?? {})) {
    const values = propertyValues(entity, pid);
    if (values.length > 0) statements[pid] = values;
  }

  const aliases: Record<string, string[]> = {};
  for (const [lang, list] of Object.entries(entity.aliases ?? {})) {
    aliases[lang] = list.map((a) => a.value);
  }

  const sitelinks: Record<string, string> = {};
  const sitelinkBadges: Record<string, string[]> = {};
  for (const [site, link] of Object.entries(entity.sitelinks ?? {})) {
    sitelinks[site] = link.title;
    if (link.badges && link.badges.length > 0) sitelinkBadges[site] = link.badges;
  }

  return {
    id: entity.id,
    labels: termMap(entity.labels),
    descriptions: termMap(entity.descriptions),
    aliases,
    sitelinks,
    // Only present when some sitelink has a badge, keeping `items.data` lean.
    ...(Object.keys(sitelinkBadges).length > 0 ? { sitelinkBadges } : {}),
    statements,
  };
}

/** True when one of the item's (best-rank) `instance of` values is `classQid`. */
export function isInstanceOf(item: Item, classQid: string): boolean {
  return (item.statements.P31 ?? []).some((v) => v.type === "item" && v.value === classQid);
}

/** True when one of the item's (best-rank) `instance of` values is any of `classQids`. */
export function isInstanceOfAny(item: Item, classQids: ReadonlySet<string>): boolean {
  return (item.statements.P31 ?? []).some((v) => v.type === "item" && classQids.has(v.value));
}

// ---------- property entity -> PropertyRow ----------

/**
 * Wikidata's SPARQL/RDF property-type name for an entity-JSON datatype, which
 * is what the `properties.datatype` column stores (the hunt filters on
 * "ExternalId"): "external-id" → "ExternalId", "wikibase-item" → "WikibaseItem",
 * "commonsMedia" → "CommonsMedia", "monolingualtext" → "Monolingualtext".
 */
export function datatypeName(jsonDatatype: string): string {
  return jsonDatatype
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

/** Item class whose instances mirror Wikidata ids — see `properties.mirrorsWikidata`. */
export const RECIPROCAL_WIKIDATA_CLASS = "Q24075706";
/** "formatter URL" — turns an external-id value into a link. */
const FORMATTER_URL = "P1630";

/**
 * The `properties` row for a property entity, or null when it has no English
 * label (the SPARQL sync skipped those too) or is not a property at all.
 */
export function propertyRowFromEntity(entity: Entity): PropertyRow | null {
  if (entity.type !== "property" || !/^P\d+$/.test(entity.id)) return null;
  const label = entity.labels?.en?.value;
  if (!label) return null;
  const formatter = propertyValues(entity, FORMATTER_URL).find(
    (v) => v.type === "string" || v.type === "url" || v.type === "external-id",
  );
  return {
    pid: entity.id,
    label,
    datatype: entity.datatype ? datatypeName(entity.datatype) : null,
    formatterUrl: formatter?.value ?? null,
    mirrorsWikidata: propertyValues(entity, "P31").some(
      (v) => v.type === "item" && v.value === RECIPROCAL_WIKIDATA_CLASS,
    ),
  };
}
