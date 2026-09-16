import { useMemo, useState } from "react";

// ---------- Types ----------

type ValueType = "item" | "string" | "time" | "quantity" | "url" | "external-id";

interface Value {
  type: ValueType;
  value: string;
  /** Human label for item values; ignored otherwise. */
  label?: string;
}

interface Item {
  id: string;
  labels: Record<string, string>;
  descriptions: Record<string, string>;
  aliases: Record<string, string[]>;
  sitelinks: Record<string, string>;
  statements: Record<string, Value[]>;
}

type Status = "identical" | "similar" | "distinct";
/** Row-level category: a row is one-sided when only one item has any value for it. */
type RowStatus = Status | "one-sided";

interface AnnotatedValue extends Value {
  status: Status; // how this value relates to the other side
  note?: string;
}

interface Row {
  key: string; // e.g. "P31" or "label:en" or "sitelink:enwiki"
  label: string;
  kind: "term" | "sitelink" | "statement";
  status: RowStatus;
  blocker: boolean; // wbmergeitems would reject without ignoreconflicts
  a: AnnotatedValue[];
  b: AnnotatedValue[];
  note?: string;
}

// ---------- Dummy data ----------

const PROPERTY_LABELS: Record<string, string> = {
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

interface Example {
  name: string;
  a: Item;
  b: Item;
}

const EXAMPLES: Example[] = [
  {
    name: "Game with conflicts",
    a: {
      id: "Q100001",
      labels: { en: "Starfall Drift", de: "Starfall Drift" },
      descriptions: { en: "2019 video game" },
      aliases: { en: ["Starfall"] },
      sitelinks: { enwiki: "Starfall Drift" },
      statements: {
        P31: [{ type: "item", value: "Q7889", label: "video game" }],
        P136: [{ type: "item", value: "Q744038", label: "role-playing video game" }],
        P178: [{ type: "item", value: "Q100010", label: "Lantern Forge" }],
        P123: [{ type: "item", value: "Q100011", label: "Meridian Games" }],
        P400: [
          { type: "item", value: "Q1406", label: "Microsoft Windows" },
          { type: "item", value: "Q5014725", label: "PlayStation 4" },
        ],
        P577: [{ type: "time", value: "2019-03-12" }],
        P856: [{ type: "url", value: "https://starfalldrift.com" }],
        P1733: [{ type: "external-id", value: "812340" }],
        P404: [{ type: "item", value: "Q208850", label: "single-player video game" }],
      },
    },
    b: {
      id: "Q100002",
      labels: { en: "Starfall Drift", fr: "Starfall Drift" },
      descriptions: { en: "action role-playing game released in 2019" },
      aliases: { en: ["Star Fall Drift", "Starfall"] },
      sitelinks: { enwiki: "Starfall Drift (video game)", dewiki: "Starfall Drift" },
      statements: {
        P31: [{ type: "item", value: "Q7889", label: "video game" }],
        P136: [{ type: "item", value: "Q1422746", label: "action role-playing game" }],
        P123: [{ type: "item", value: "Q100011", label: "Meridian Games" }],
        P400: [
          { type: "item", value: "Q1406", label: "Microsoft Windows" },
          { type: "item", value: "Q19610114", label: "Nintendo Switch" },
        ],
        P577: [{ type: "time", value: "2019" }],
        P856: [{ type: "url", value: "http://www.starfalldrift.com/" }],
        P1733: [{ type: "external-id", value: "812341" }],
        P2725: [{ type: "external-id", value: "1207658924" }],
        P1476: [{ type: "string", value: "Starfall Drift" }],
      },
    },
  },
  {
    name: "Clean merge (author)",
    a: {
      id: "Q100201",
      labels: { en: "Miriam Okafor" },
      descriptions: { en: "Nigerian novelist" },
      aliases: {},
      sitelinks: { enwiki: "Miriam Okafor" },
      statements: {
        P31: [{ type: "item", value: "Q5", label: "human" }],
        P569: [{ type: "time", value: "1978-05-03" }],
        P27: [{ type: "item", value: "Q1033", label: "Nigeria" }],
        P106: [{ type: "item", value: "Q6625963", label: "novelist" }],
        P214: [{ type: "external-id", value: "305418833" }],
      },
    },
    b: {
      id: "Q100340",
      labels: { en: "Miriam Okafor", ig: "Miriam Okafor" },
      descriptions: { fr: "romancière nigériane" },
      aliases: { en: ["M. Okafor"] },
      sitelinks: { igwiki: "Miriam Okafor" },
      statements: {
        P31: [{ type: "item", value: "Q5", label: "human" }],
        P569: [{ type: "time", value: "1978" }],
        P27: [{ type: "item", value: "Q1033", label: "Nigeria" }],
        P106: [
          { type: "item", value: "Q6625963", label: "novelist" },
          { type: "item", value: "Q49757", label: "poet" },
        ],
        P2002: [{ type: "external-id", value: "miriamokafor" }],
      },
    },
  },
  {
    name: "Different things (film vs novel)",
    a: {
      id: "Q100450",
      labels: { en: "The Glass Orchard" },
      descriptions: { en: "2015 film directed by Hana Lindqvist" },
      aliases: {},
      sitelinks: { enwiki: "The Glass Orchard (film)" },
      statements: {
        P31: [{ type: "item", value: "Q11424", label: "film" }],
        P577: [{ type: "time", value: "2015-09-18" }],
        P57: [{ type: "item", value: "Q100460", label: "Hana Lindqvist" }],
        P136: [{ type: "item", value: "Q130232", label: "drama film" }],
        P495: [{ type: "item", value: "Q34", label: "Sweden" }],
      },
    },
    b: {
      id: "Q100612",
      labels: { en: "The Glass Orchard", sv: "Glasträdgården" },
      descriptions: { en: "2009 novel by Elin Berg" },
      aliases: {},
      sitelinks: { enwiki: "The Glass Orchard (novel)", svwiki: "Glasträdgården" },
      statements: {
        P31: [{ type: "item", value: "Q7725634", label: "literary work" }],
        P577: [{ type: "time", value: "2009" }],
        P50: [{ type: "item", value: "Q100613", label: "Elin Berg" }],
        P136: [{ type: "item", value: "Q8261", label: "novel" }],
        P495: [{ type: "item", value: "Q34", label: "Sweden" }],
      },
    },
  },
  {
    name: "Company renamed",
    a: {
      id: "Q100700",
      labels: { en: "Meridian Games" },
      descriptions: { en: "video game developer" },
      aliases: {},
      sitelinks: { enwiki: "Meridian Games" },
      statements: {
        P31: [{ type: "item", value: "Q4830453", label: "business" }],
        P571: [{ type: "time", value: "2004-02" }],
        P159: [{ type: "item", value: "Q16552", label: "Denver" }],
        P856: [{ type: "url", value: "https://www.meridiangames.com/" }],
        P1128: [{ type: "quantity", value: "120" }],
      },
    },
    b: {
      id: "Q100812",
      labels: { en: "Meridian Interactive" },
      descriptions: { en: "American video game developer" },
      aliases: { en: ["Meridian Games"] },
      sitelinks: {},
      statements: {
        P31: [{ type: "item", value: "Q4830453", label: "business" }],
        P571: [{ type: "time", value: "2004" }],
        P159: [{ type: "item", value: "Q16552", label: "Denver" }],
        P856: [{ type: "url", value: "https://meridiangames.com" }],
        P1128: [{ type: "quantity", value: "124" }],
        P1441: [{ type: "item", value: "Q100001", label: "Starfall Drift" }],
      },
    },
  },
];

// ---------- Comparison ----------

function normalize(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/^https?:\/\/(www\.)?/, "")
    .replace(/\/+$/, "")
    .replace(/\s+/g, " ");
}

function levenshtein(a: string, b: string): number {
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

function stringSimilarity(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return 1;
  const max = Math.max(na.length, nb.length);
  return max === 0 ? 1 : 1 - levenshtein(na, nb) / max;
}

/** Returns [status, note] for a pair of values of the same property. */
function compareValues(x: Value, y: Value): [Status, string?] {
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

function compareSets(
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

function buildRows(a: Item, b: Item): Row[] {
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

// ---------- UI ----------

function ValueChip({ v }: { v: AnnotatedValue }) {
  const text = v.type === "item" ? (v.label ?? v.value) : v.value;
  return (
    <span
      className={`chip chip-${v.status}`}
      title={v.note ?? (v.type === "item" ? v.value : undefined)}
    >
      {text}
      {v.type === "item" && <span className="chip-id">{v.value}</span>}
    </span>
  );
}

function ItemPlate({ item, side }: { item: Item; side: "from" | "into" }) {
  return (
    <div className={`plate plate-${side}`}>
      <div className="plate-role">{side === "from" ? "merge from" : "merge into"}</div>
      <div className="plate-label">{item.labels.en ?? item.id}</div>
      <div className="plate-meta">
        <span className="plate-id">{item.id}</span>
        {item.descriptions.en && <span className="plate-desc">{item.descriptions.en}</span>}
      </div>
    </div>
  );
}

const GROUPS: { status: RowStatus; title: string }[] = [
  { status: "identical", title: "Identical" },
  { status: "similar", title: "Similar" },
  { status: "distinct", title: "Distinct" },
  { status: "one-sided", title: "One-sided" },
];

/** Wikidata convention: the newer (higher-numbered) item is merged into the older one. */
function orderByAge(x: Item, y: Item): [from: Item, into: Item] {
  const n = (id: string) => parseInt(id.replace(/^Q/, ""), 10);
  return n(x.id) > n(y.id) ? [x, y] : [y, x];
}

export default function MergeCandidates() {
  const [exampleIdx, setExampleIdx] = useState(0);
  const [hidden, setHidden] = useState<Record<RowStatus, boolean>>({
    identical: false,
    similar: false,
    distinct: false,
    "one-sided": false,
  });

  const example = EXAMPLES[exampleIdx];
  const [from, into] = useMemo(() => orderByAge(example.a, example.b), [example]);

  const rows = useMemo(() => buildRows(from, into), [from, into]);
  const blockers = rows.filter((r) => r.blocker);
  const counts = rows.reduce((acc, r) => ({ ...acc, [r.status]: acc[r.status] + 1 }), {
    identical: 0,
    similar: 0,
    distinct: 0,
    "one-sided": 0,
  } as Record<RowStatus, number>);

  return (
    <div className="mc">
      <nav className="examples" aria-label="Example pairs">
        {EXAMPLES.map((ex, i) => (
          <button
            key={ex.name}
            className={i === exampleIdx ? "is-active" : undefined}
            onClick={() => setExampleIdx(i)}
            aria-pressed={i === exampleIdx}
          >
            {ex.name}
          </button>
        ))}
      </nav>
      <header className="mc-head">
        <ItemPlate item={from} side="from" />
        <div className="arrow" aria-hidden="true" title="Higher ID merges into lower ID">
          →
        </div>
        <ItemPlate item={into} side="into" />
      </header>

      <div className="mc-toolbar">
        <div className="legend">
          {GROUPS.map((g) => (
            <button
              key={g.status}
              className={`legend-btn ${hidden[g.status] ? "is-off" : ""}`}
              onClick={() => setHidden((h) => ({ ...h, [g.status]: !h[g.status] }))}
              aria-pressed={!hidden[g.status]}
            >
              <span className={`dot dot-${g.status}`} />
              {g.title} <b>{counts[g.status]}</b>
            </button>
          ))}
        </div>
      </div>

      {blockers.length > 0 && (
        <div className="blockers" role="status">
          <strong>
            {blockers.length} conflict{blockers.length > 1 ? "s" : ""} block merge
          </strong>
          <ul className="blocker-list">
            {blockers.map((r) => (
              <li key={r.key}>
                <span className="blocker-prop">{r.label}</span>
                <span className="blocker-values">
                  {r.a.map((v, i) => (
                    <ValueChip key={"a" + i} v={v} />
                  ))}
                  <span className="blocker-vs">vs</span>
                  {r.b.map((v, i) => (
                    <ValueChip key={"b" + i} v={v} />
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {GROUPS.filter((g) => !hidden[g.status]).map((g) => {
        // P31 first; everything else keeps its build order (terms, sitelinks, statements).
        const groupRows = rows
          .filter((r) => r.status === g.status)
          .sort((x, y) => Number(y.key === "P31") - Number(x.key === "P31"));
        return (
          <section key={g.status} className={`group group-${g.status}`}>
            <h2>
              {g.title} <span className="group-count">{groupRows.length}</span>
            </h2>
            {groupRows.length === 0 ? (
              <p className="empty">Nothing here.</p>
            ) : (
              <div className="ledger-wrap">
                <table className="ledger">
                  <thead>
                    <tr>
                      <th className="col-prop">property</th>
                      <th className="col-a">{from.id}</th>
                      <th className="col-b">{into.id}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {groupRows.map((r) => (
                      <tr key={r.key} className={r.blocker ? "is-blocker" : undefined}>
                        <td className="col-prop">
                          <div className="prop-label">{r.label}</div>
                          <div className="prop-key">
                            {r.kind === "statement" ? (
                              <a
                                href={`https://www.wikidata.org/wiki/Property:${r.key}`}
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                {r.key}
                              </a>
                            ) : (
                              r.kind
                            )}
                          </div>
                          {r.note && <div className="prop-note">{r.note}</div>}
                          {!r.note && r.a.concat(r.b).find((v) => v.note) && (
                            <div className="prop-note">
                              {r.a.concat(r.b).find((v) => v.note)!.note}
                            </div>
                          )}
                        </td>
                        <td className="col-a">
                          {r.a.length === 0 ? (
                            <span className="none">—</span>
                          ) : (
                            r.a.map((v, i) => <ValueChip key={i} v={v} />)
                          )}
                        </td>
                        <td className="col-b">
                          {r.b.length === 0 ? (
                            <span className="none">—</span>
                          ) : (
                            r.b.map((v, i) => <ValueChip key={i} v={v} />)
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
