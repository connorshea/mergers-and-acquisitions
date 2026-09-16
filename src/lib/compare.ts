// Wikidata item comparison heuristics.
//
// This module is intentionally DOM-free and dependency-free so it can be shared
// by the React UI, the server routes, and the background jobs (sync +
// candidate hunting). Keep it that way — no React, no browser globals.

// ---------- Types ----------

export type ValueType = "item" | "string" | "time" | "quantity" | "url" | "external-id";

export interface Value {
  type: ValueType;
  value: string;
  /** Human label for item values; ignored otherwise. */
  label?: string;
}

export interface Item {
  id: string;
  labels: Record<string, string>;
  descriptions: Record<string, string>;
  aliases: Record<string, string[]>;
  sitelinks: Record<string, string>;
  statements: Record<string, Value[]>;
}

export type Status = "identical" | "similar" | "distinct";
/** Row-level category: a row is one-sided when only one item has any value for it. */
export type RowStatus = Status | "one-sided";

export interface AnnotatedValue extends Value {
  status: Status; // how this value relates to the other side
  note?: string;
}

export interface Row {
  key: string; // e.g. "P31" or "label:en" or "sitelink:enwiki"
  label: string;
  kind: "term" | "sitelink" | "statement";
  status: RowStatus;
  blocker: boolean; // wbmergeitems would reject without ignoreconflicts
  a: AnnotatedValue[];
  b: AnnotatedValue[];
  note?: string;
}

// ---------- Property labels ----------

export const PROPERTY_LABELS: Record<string, string> = {
  P31: "instance of",
  P136: "genre",
  P178: "developer",
  P123: "publisher",
  P400: "platform",
  P577: "publication date",
  P856: "official website",
  P1733: "Steam application ID",
  P2725: "GOG application ID",
  P404: "game mode",
  P1476: "title",
  P569: "date of birth",
  P27: "country of citizenship",
  P106: "occupation",
  P214: "VIAF ID",
  P2002: "X username",
  P57: "director",
  P50: "author",
  P495: "country of origin",
  P571: "inception",
  P159: "headquarters location",
  P1128: "employees",
  P1441: "present in work",
};

// ---------- Comparison ----------

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/^https?:\/\/(www\.)?/, "")
    .replace(/\/+$/, "")
    .replace(/\s+/g, " ");
}

export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[n];
}

export function stringSimilarity(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return 1;
  const max = Math.max(na.length, nb.length);
  return max === 0 ? 1 : 1 - levenshtein(na, nb) / max;
}

/** Returns [status, note] for a pair of values of the same property. */
export function compareValues(x: Value, y: Value): [Status, string?] {
  if (x.type !== y.type) return ["distinct"];
  if (x.value === y.value) return ["identical"];

  switch (x.type) {
    case "item":
      // Different QIDs; fall back to label similarity as a hint only.
      if (x.label && y.label && stringSimilarity(x.label, y.label) >= 0.6)
        return ["similar", "different items with similar labels"];
      return ["distinct"];
    case "time": {
      const yx = x.value.slice(0, 4);
      const yy = y.value.slice(0, 4);
      if (yx === yy) return ["similar", "same year, different precision"];
      return ["distinct"];
    }
    case "quantity":
    case "external-id":
      return ["distinct"]; // must match exactly
    case "url":
      if (normalize(x.value) === normalize(y.value)) return ["similar", "same host and path"];
      return ["distinct"];
    case "string": {
      const s = stringSimilarity(x.value, y.value);
      if (s === 1) return ["similar", "equal after normalization"];
      if (s >= 0.75) return ["similar", `${Math.round(s * 100)}% string match`];
      return ["distinct"];
    }
  }
}

export function compareSets(
  a: Value[],
  b: Value[],
): { status: Status; a: AnnotatedValue[]; b: AnnotatedValue[] } {
  const annotate = (side: Value[], other: Value[]): AnnotatedValue[] =>
    side.map((v) => {
      let best: Status = "distinct";
      let note: string | undefined;
      for (const o of other) {
        const [s, n] = compareValues(v, o);
        if (s === "identical") return { ...v, status: s };
        if (s === "similar" && best !== "similar") {
          best = "similar";
          note = n;
        }
      }
      return { ...v, status: best, note };
    });

  const aa = annotate(a, b);
  const bb = annotate(b, a);
  const all = [...aa, ...bb];
  let status: Status;
  if (all.every((v) => v.status === "identical")) status = "identical";
  else if (all.some((v) => v.status !== "distinct")) status = "similar";
  else status = "distinct";
  return { status, a: aa, b: bb };
}

export function buildRows(a: Item, b: Item): Row[] {
  const rows: Row[] = [];

  /**
   * Label/alias values are also checked against the *other* term kind on the
   * opposite item (an alias here vs. the label there, and vice versa), so a
   * renamed or re-aliased item still shows up as similar rather than distinct.
   */
  const termRow = (
    key: string,
    label: string,
    va: string[],
    vb: string[],
    blocker: boolean,
    cross?: { a: string[]; b: string[]; what: string },
  ) => {
    const cmp = compareSets(
      va.map((v) => ({ type: "string" as const, value: v })),
      vb.map((v) => ({ type: "string" as const, value: v })),
    );
    let crossMatched = false;
    if (cross) {
      const mark = (vals: AnnotatedValue[], pool: string[], otherId: string) => {
        for (const v of vals) {
          if (v.status === "identical") continue;
          if (pool.some((p) => normalize(p) === normalize(v.value))) {
            v.status = "similar";
            v.note = `matches ${cross.what} on ${otherId}`;
            crossMatched = true;
          }
        }
      };
      mark(cmp.a, cross.b, b.id);
      mark(cmp.b, cross.a, a.id);
    }
    const oneSided = (va.length === 0 || vb.length === 0) && !crossMatched;
    const all = [...cmp.a, ...cmp.b];
    let status: RowStatus;
    if (oneSided) status = "one-sided";
    else if (all.every((v) => v.status === "identical")) status = "identical";
    else if (all.some((v) => v.status !== "distinct")) status = "similar";
    else status = "distinct";
    rows.push({
      key,
      label,
      kind: "term",
      status,
      blocker: blocker && status !== "identical" && status !== "one-sided",
      a: cmp.a,
      b: cmp.b,
    });
  };

  const langs = (o: Record<string, unknown>, p: Record<string, unknown>) =>
    Array.from(new Set([...Object.keys(o), ...Object.keys(p)])).sort();

  for (const l of langs(a.labels, b.labels))
    termRow(
      `label:${l}`,
      `label (${l})`,
      a.labels[l] ? [a.labels[l]] : [],
      b.labels[l] ? [b.labels[l]] : [],
      false,
      {
        a: a.aliases[l] ?? [],
        b: b.aliases[l] ?? [],
        what: "an alias",
      },
    );
  for (const l of langs(a.descriptions, b.descriptions))
    termRow(
      `description:${l}`,
      `description (${l})`,
      a.descriptions[l] ? [a.descriptions[l]] : [],
      b.descriptions[l] ? [b.descriptions[l]] : [],
      true, // conflicting descriptions block wbmergeitems unless ignoreconflicts=description
    );
  for (const l of langs(a.aliases, b.aliases))
    termRow(`alias:${l}`, `aliases (${l})`, a.aliases[l] ?? [], b.aliases[l] ?? [], false, {
      a: a.labels[l] ? [a.labels[l]] : [],
      b: b.labels[l] ? [b.labels[l]] : [],
      what: "the label",
    });

  for (const wiki of langs(a.sitelinks, b.sitelinks)) {
    const va = a.sitelinks[wiki] ? [{ type: "string" as const, value: a.sitelinks[wiki] }] : [];
    const vb = b.sitelinks[wiki] ? [{ type: "string" as const, value: b.sitelinks[wiki] }] : [];
    const cmp = compareSets(va, vb);
    const oneSided = va.length === 0 || vb.length === 0;
    rows.push({
      key: `sitelink:${wiki}`,
      label: wiki,
      kind: "sitelink",
      status: oneSided ? "one-sided" : cmp.status,
      blocker: !oneSided && cmp.status !== "identical",
      a: cmp.a,
      b: cmp.b,
      note:
        !oneSided && cmp.status !== "identical"
          ? "two different pages on the same wiki — a real merge would need one removed first"
          : undefined,
    });
  }

  for (const pid of langs(a.statements, b.statements)) {
    const va = a.statements[pid] ?? [];
    const vb = b.statements[pid] ?? [];
    const cmp = compareSets(va, vb);
    const oneSided = va.length === 0 || vb.length === 0;
    rows.push({
      key: pid,
      label: PROPERTY_LABELS[pid] ?? pid,
      kind: "statement",
      status: oneSided ? "one-sided" : cmp.status,
      blocker: false,
      a: cmp.a,
      b: cmp.b,
    });
  }

  return rows;
}

/** Wikidata convention: the newer (higher-numbered) item is merged into the older one. */
export function orderByAge(x: Item, y: Item): [from: Item, into: Item] {
  const n = (id: string) => parseInt(id.replace(/^Q/, ""), 10);
  return n(x.id) > n(y.id) ? [x, y] : [y, x];
}

// ---------- Confidence scoring ----------

export interface CandidateScore {
  /** 0–1 likelihood the two items are the same subject and should be merged. */
  confidence: number;
  /** Human-readable signals that fed the score. */
  reasons: string[];
  /** Whether a real wbmergeitems call would hit a conflict (description / same-wiki sitelink). */
  hasBlocker: boolean;
}

/**
 * Heuristic duplicate-confidence score for a pair of items, built on top of
 * buildRows. Combines a handful of signals — shared external identifiers, same
 * vs. different `instance of` (P31), label agreement (including label<->alias
 * cross-matches from renames), and how much of the shared statements agree —
 * into a 0–1 score. Blockers (conflicting descriptions or same-wiki sitelinks)
 * are surfaced via `hasBlocker` but do not by themselves sink the score: real
 * duplicates routinely have conflicting descriptions.
 */
export function scoreCandidate(a: Item, b: Item): CandidateScore {
  const rows = buildRows(a, b);
  const reasons: string[] = [];
  let score = 0;

  // Shared external identifiers are the strongest single signal.
  const sharedExtIds = rows.filter(
    (r) =>
      r.kind === "statement" &&
      r.status === "identical" &&
      r.a.some((v) => v.type === "external-id"),
  );
  if (sharedExtIds.length > 0) {
    score += 0.6;
    reasons.push(`shares external identifier: ${sharedExtIds.map((r) => r.label).join(", ")}`);
  }

  // Instance of (P31): agreement supports a merge; disagreement strongly opposes.
  const p31 = rows.find((r) => r.key === "P31");
  if (p31) {
    if (p31.status === "identical") {
      score += 0.2;
      reasons.push("same instance of (P31)");
    } else if (p31.status === "distinct") {
      score -= 0.45;
      reasons.push("different instance of (P31)");
    }
  }

  // Label agreement, including label<->alias cross-matches (renames).
  const labelRows = rows.filter((r) => r.key.startsWith("label:"));
  const crossMatched = rows.some(
    (r) =>
      (r.key.startsWith("label:") || r.key.startsWith("alias:")) &&
      [...r.a, ...r.b].some((v) => v.note?.startsWith("matches ")),
  );
  if (labelRows.some((r) => r.status === "identical")) {
    score += 0.25;
    reasons.push("identical label");
  } else if (crossMatched) {
    score += 0.2;
    reasons.push("label matches the other item's alias");
  } else if (labelRows.some((r) => r.status === "similar")) {
    score += 0.1;
    reasons.push("similar label");
  }

  // How much of the shared statement set agrees (excluding P31, counted above).
  const stmtRows = rows.filter((r) => r.kind === "statement" && r.key !== "P31");
  const agreeing = stmtRows.filter((r) => r.status === "identical" || r.status === "similar");
  if (stmtRows.length > 0 && agreeing.length > 0) {
    score += 0.2 * (agreeing.length / stmtRows.length);
    reasons.push(`${agreeing.length} of ${stmtRows.length} shared statements agree`);
  }

  const blockers = rows.filter((r) => r.blocker);
  if (blockers.length > 0) {
    reasons.push(
      `${blockers.length} conflict${blockers.length > 1 ? "s" : ""} would block the merge`,
    );
  }

  const confidence = Math.max(0, Math.min(1, score));
  return { confidence, reasons, hasBlocker: blockers.length > 0 };
}
