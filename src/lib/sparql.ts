// Minimal SPARQL client for Wikidata, talking to the QLever mirror by default
// (see CLAUDE.md: QLever, never WDQS). DOM-free and dependency-free — uses only
// global `fetch`, so it runs in Cloudflare Workers, crons/queues, and Node.
//
// QLever, unlike WDQS, requires every prefix to be declared on each query and
// does not support Blazegraph extensions (the label service, named subqueries).
// PREFIXES below covers the vocabulary these queries use.

export const DEFAULT_SPARQL_ENDPOINT = "https://qlever.dev/api/wikidata";

const PREFIXES = `PREFIX wd: <http://www.wikidata.org/entity/>
PREFIX wdt: <http://www.wikidata.org/prop/direct/>
PREFIX wikibase: <http://wikiba.se/ontology#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX schema: <http://schema.org/>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
`;

const DEFAULT_USER_AGENT =
  "mergers-and-acquisitions/0.1 (https://github.com/connorshea; Wikidata merge tool)";

/** One term binding in a SPARQL JSON result row. */
export interface SparqlTerm {
  type: string;
  value: string;
  datatype?: string;
  "xml:lang"?: string;
}
export type SparqlBinding = Record<string, SparqlTerm | undefined>;

export interface SparqlOptions {
  /** Override the endpoint (defaults to WIKIDATA_SPARQL_ENDPOINT env, then QLever). */
  endpoint?: string;
  userAgent?: string;
}

function resolveEndpoint(opts?: SparqlOptions): string {
  if (opts?.endpoint) return opts.endpoint;
  // process may be undefined in a Worker; guard rather than assume Node.
  const fromEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env?.WIKIDATA_SPARQL_ENDPOINT;
  return fromEnv ?? DEFAULT_SPARQL_ENDPOINT;
}

/** Run a SPARQL SELECT and return its result bindings. Throws on a non-2xx. */
export async function sparqlSelect(query: string, opts?: SparqlOptions): Promise<SparqlBinding[]> {
  const res = await fetch(resolveEndpoint(opts), {
    method: "POST",
    headers: {
      Accept: "application/sparql-results+json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": opts?.userAgent ?? DEFAULT_USER_AGENT,
    },
    body: new URLSearchParams({ query: PREFIXES + query }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`SPARQL request failed (${res.status}): ${body.slice(0, 300)}`);
  }
  const json = (await res.json()) as { results?: { bindings?: SparqlBinding[] } };
  return json.results?.bindings ?? [];
}

/** "http://www.wikidata.org/entity/P1733" → "P1733". */
function localName(iri: string): string {
  const cut = Math.max(iri.lastIndexOf("/"), iri.lastIndexOf("#"));
  return cut >= 0 ? iri.slice(cut + 1) : iri;
}

export interface PropertyRow {
  pid: string; // "P1733"
  label: string; // "Steam application ID"
  datatype: string | null; // "ExternalId", "WikibaseItem", …
}

/**
 * Fetch every Wikidata property with its English label and datatype in one
 * query (~12k rows). Used to populate the `properties` table so the UI can show
 * property names instead of bare Pxxx ids.
 */
export async function fetchAllProperties(opts?: SparqlOptions): Promise<PropertyRow[]> {
  const query = `SELECT ?p ?pLabel ?type WHERE {
  ?p a wikibase:Property .
  ?p wikibase:propertyType ?type .
  ?p rdfs:label ?pLabel .
  FILTER(lang(?pLabel) = "en")
}`;
  const bindings = await sparqlSelect(query, opts);
  const rows: PropertyRow[] = [];
  for (const b of bindings) {
    if (!b.p || !b.pLabel) continue;
    const pid = localName(b.p.value);
    if (!/^P\d+$/.test(pid)) continue;
    rows.push({
      pid,
      label: b.pLabel.value,
      datatype: b.type ? localName(b.type.value) : null,
    });
  }
  return rows;
}

export interface EntityLabelRow {
  qid: string; // "Q744038"
  label: string; // "role-playing video game"
}

/**
 * Fetch English labels for the Wikidata *items* that appear as statement values
 * of in-scope games (genre, platform, developer, publisher, instance of, …).
 * QLever derives the value set itself — every item-valued direct claim on a
 * video game (P31 = Q7889) or free/libre video game (Q21125433) — so we never
 * enumerate QIDs from our own DB. That keeps this to the entities we actually
 * display (tens of thousands) rather than all of Wikidata. Restricting to
 * `wikibase:WikibaseItem` properties drops external-ids/strings/dates, which
 * carry their own value, not a QID needing a label.
 */
export async function fetchEntityLabels(opts?: SparqlOptions): Promise<EntityLabelRow[]> {
  const query = `SELECT DISTINCT ?v ?vLabel WHERE {
  VALUES ?t { wd:Q7889 wd:Q21125433 }
  ?game wdt:P31 ?t .
  ?game ?claim ?v .
  ?prop wikibase:directClaim ?claim .
  ?prop wikibase:propertyType wikibase:WikibaseItem .
  ?v rdfs:label ?vLabel .
  FILTER(lang(?vLabel) = "en")
}`;
  const bindings = await sparqlSelect(query, opts);
  const rows: EntityLabelRow[] = [];
  for (const b of bindings) {
    if (!b.v || !b.vLabel) continue;
    const qid = localName(b.v.value);
    if (!/^Q\d+$/.test(qid)) continue;
    rows.push({ qid, label: b.vLabel.value });
  }
  return rows;
}
