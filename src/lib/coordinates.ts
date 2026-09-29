// Geographic coordinate values (Wikidata's `globecoordinate` datatype, e.g.
// P625): building the `coordinate` Value both converters emit, distances
// between two of them, and their display text / tooltip / map link. DOM-free
// like compare.ts, which uses it.

import type { Value } from "./compare.ts";

/** Earth, the globe a coordinate is on unless it says otherwise. */
export const EARTH = "Q2";

/**
 * Mean radius in metres of the globes Wikidata coordinates commonly sit on, for
 * distances and precision in metres. A globe missing here gets neither.
 */
const GLOBE_RADIUS_M: Record<string, number> = {
  Q2: 6_371_008.8, // Earth
  Q405: 1_737_400, // Moon
  Q111: 3_389_500, // Mars
};

/**
 * A `coordinate` Value. `value` is the canonical "lat,lon" string (with the
 * globe appended when it isn't Earth, so a Mars point never equals an Earth
 * point with the same numbers), which keeps value equality, dedup and hashing
 * working unchanged. `globe` is omitted for Earth and `precision` when unknown,
 * keeping `items.data` lean.
 */
export function coordinateValue(
  latitude: number,
  longitude: number,
  precision?: number | null,
  globe: string = EARTH,
): Value {
  const onEarth = globe === EARTH;
  return {
    type: "coordinate",
    value: onEarth ? `${latitude},${longitude}` : `${latitude},${longitude},${globe}`,
    latitude,
    longitude,
    ...(typeof precision === "number" && precision > 0 ? { precision } : {}),
    ...(onEarth ? {} : { globe }),
  };
}

/** The globe QID of a coordinate value. */
export const globeOf = (v: Value): string => v.globe ?? EARTH;

/**
 * Parse a WKT point literal as SPARQL returns `wdt:P625` and friends:
 * "Point(<lon> <lat>)" — longitude first — prefixed with the globe's entity IRI
 * when it isn't Earth ("<http://www.wikidata.org/entity/Q111> Point(…)").
 * Null when the literal isn't such a point.
 */
export function parseWktPoint(literal: string): Value | null {
  const m =
    /^\s*(?:<https?:\/\/www\.wikidata\.org\/entity\/(Q\d+)>\s*)?Point\(\s*(\S+)\s+(\S+)\s*\)\s*$/i.exec(
      literal,
    );
  if (!m) return null;
  const longitude = Number(m[2]);
  const latitude = Number(m[3]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  // The truthy literal carries no precision.
  return coordinateValue(latitude, longitude, undefined, m[1] ?? EARTH);
}

const radians = (deg: number): number => (deg * Math.PI) / 180;

/**
 * Great-circle (haversine) distance in metres between two coordinate values,
 * or null when they're on different globes or on a globe of unknown size.
 */
export function coordinateDistance(x: Value, y: Value): number | null {
  if (globeOf(x) !== globeOf(y)) return null;
  const r = GLOBE_RADIUS_M[globeOf(x)];
  if (r === undefined || x.latitude === undefined || y.latitude === undefined) return null;
  const dLat = radians(y.latitude - x.latitude);
  const dLon = radians((y.longitude ?? 0) - (x.longitude ?? 0));
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(x.latitude)) * Math.cos(radians(y.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** A length for people: "320 m", "4.2 km", "48 km". */
export function formatMeters(m: number): string {
  if (m < 1000) return `${Math.round(m)} m`;
  const km = m / 1000;
  return km < 10 ? `${Math.round(km * 10) / 10} km` : `${Math.round(km).toLocaleString("en")} km`;
}

/** Decimal places the stated precision (in degrees) supports; 5 (≈1 m) when unknown. */
function decimalsFor(precision?: number): number {
  if (precision === undefined || precision <= 0) return 5;
  // The epsilon keeps 0.0001 at 4 rather than 5 through float noise.
  return Math.min(9, Math.max(0, Math.ceil(-Math.log10(precision) - 1e-9)));
}

/** One axis in hemisphere form: "51.5007° N". Exactly 0° and 180° take no letter. */
function axis(deg: number, decimals: number, pos: string, neg: string): string {
  const text = Math.abs(deg)
    .toFixed(decimals)
    .replace(/(\.\d*?)0+$/, "$1")
    .replace(/\.$/, "");
  const n = Number(text);
  if (n === 0 || (pos === "E" && n === 180)) return `${text}°`;
  return `${text}° ${deg < 0 ? neg : pos}`;
}

/**
 * Display text for a coordinate value, rounded to its precision: "51.5007° N,
 * 0.1246° W", "52° N, 1° W", or with the globe for a non-Earth value: "18.65° N,
 * 226.2° E (Mars)". An Earth longitude past ±180° is brought back into range;
 * other globes keep theirs (Mars uses 0–360° east).
 */
export function formatCoordinate(v: Value): string {
  const decimals = decimalsFor(v.precision);
  const globe = globeOf(v);
  let lon = v.longitude ?? 0;
  if (globe === EARTH && (lon > 180 || lon < -180)) lon = ((((lon + 180) % 360) + 360) % 360) - 180;
  const text = `${axis(v.latitude ?? 0, decimals, "N", "S")}, ${axis(lon, decimals, "E", "W")}`;
  return globe === EARTH ? text : `${text} (${v.globeLabel ?? globe})`;
}

/** Tooltip for a coordinate value: the raw decimal pair and its precision in metres. */
export function coordinateTooltip(v: Value): string {
  const raw = `${v.latitude}, ${v.longitude}`;
  const r = GLOBE_RADIUS_M[globeOf(v)];
  if (v.precision === undefined || r === undefined) return raw;
  return `${raw} (±${formatMeters(radians(v.precision) * r)})`;
}

/**
 * GeoHack page for a coordinate value (Toolforge-hosted; what Wikipedia links
 * to). Null for a non-Earth value whose globe has no label yet: GeoHack would
 * otherwise show the point on Earth's maps.
 */
export function geohackUrl(v: Value): string | null {
  if (v.latitude === undefined || v.longitude === undefined) return null;
  const globe = globeOf(v);
  const name = globe === EARTH ? "Earth" : v.globeLabel;
  if (!name) return null;
  return `https://geohack.toolforge.org/geohack.php?params=${v.latitude}_N_${v.longitude}_E_globe:${encodeURIComponent(name)}`;
}
