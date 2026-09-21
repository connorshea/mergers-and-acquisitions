import { useMemo, useState } from "react";
import type { AnnotatedValue, Item, RowStatus } from "./lib/compare.ts";
import {
  buildRows,
  formatIdUrl,
  isAutoIgnoredConflict,
  isHardcodedMirrorProp,
  sharedIdentifierProps,
} from "./lib/compare.ts";
import { wikiPageUrl } from "./lib/wiki.ts";

// ---------- UI ----------

/**
 * Wikidata's special snaks: an *unknown* value (somevalue) and an explicit *no*
 * value (novalue). Both are placeholders with no real value to show.
 */
function specialValueText(v: AnnotatedValue): string | null {
  if (v.type === "somevalue") return "unknown value";
  if (v.type === "novalue") return "no value";
  return null;
}

/**
 * Display text for a value. Wikidata day-precision dates come through as
 * `YYYY-MM-DDT00:00:00Z`; drop the (meaningless) midnight time part and show
 * just the calendar date. Non-midnight times are left intact.
 */
function displayValue(v: AnnotatedValue): string {
  const special = specialValueText(v);
  if (special) return special;
  if (v.type === "item") return v.label ?? v.value;
  if (v.type === "time") {
    const m = /^([+-]?\d{4}-\d{2}-\d{2})T00:00:00Z$/.exec(v.value);
    // Year/month precision arrives as "00" parts (+1987-00-00 → 1987).
    if (m) return m[1].replace(/^\+/, "").replace(/-00$/, "").replace(/-00$/, "");
  }
  return v.value;
}

function ValueChip({ v, formatter }: { v: AnnotatedValue; formatter?: string }) {
  const text = displayValue(v);
  const special = specialValueText(v) != null;
  // Link out where the value points somewhere: a `url` value is itself a URL
  // (e.g. an itch.io page), and an external identifier with a formatter URL
  // (P1630) resolves to its source database, e.g. a Steam app ID → store page.
  // Special (unknown/no) values are placeholders, never links.
  const idUrl = special
    ? null
    : v.type === "url"
      ? v.value
      : v.type === "external-id"
        ? formatIdUrl(formatter, v.value)
        : null;
  return (
    <span
      className={`chip chip-${v.status}${special ? " chip-special" : ""}`}
      title={v.note ?? (v.type === "item" ? v.value : v.type === "time" ? v.value : undefined)}
    >
      {idUrl ? (
        <a className="chip-link" href={idUrl} target="_blank" rel="noreferrer">
          {text}
        </a>
      ) : (
        text
      )}
      {v.type === "item" && (
        <a
          className="chip-id"
          href={wikiPageUrl(v.value)}
          target="_blank"
          rel="noreferrer"
          // Don't let the QID link inherit the chip's tooltip/selection; it's its
          // own affordance.
          title={v.value}
          onClick={(e) => e.stopPropagation()}
        >
          {v.value}
        </a>
      )}
    </span>
  );
}

function ItemPlate({ item, side }: { item: Item; side: "from" | "into" }) {
  return (
    <div className={`plate plate-${side}`}>
      <div className="plate-role">{side === "from" ? "merge from" : "merge into"}</div>
      <div className="plate-label">{item.labels.en ?? item.id}</div>
      <div className="plate-meta">
        <a className="plate-id" href={wikiPageUrl(item.id)} target="_blank" rel="noreferrer">
          {item.id}
        </a>
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

/**
 * Presentational comparison view for a single merge candidate. Callers pass the
 * pair already ordered — `from` is the item that would be merged away (higher
 * QID by Wikidata convention) and `into` the one that survives. Use
 * `orderByAge` from ./lib/compare to derive that ordering.
 */
export default function MergeCandidates({
  from,
  into,
  propertyLabels,
  propertyFormatters,
  propertyMirrors,
  valueLabels,
}: {
  from: Item;
  into: Item;
  /** Pxxx → human label, from the DB-backed properties table. */
  propertyLabels?: Record<string, string>;
  /** Pxxx → formatter URL (with "$1"), so external-id values can be linked. */
  propertyFormatters?: Record<string, string>;
  /** Pxxx that source their ids from Wikidata (synced `mirrors_wikidata`). */
  propertyMirrors?: string[];
  /** Qxxx → human label, from the DB-backed entity_labels table. */
  valueLabels?: Record<string, string>;
}) {
  // A property is Wikidata-sourced if the synced set flags it OR it's in the
  // hardcoded floor (which covers services Wikidata hasn't tagged, e.g.
  // GamerProfiles). The synced set is absent before the first property sync, so
  // the floor guarantees the well-known ones are always marked.
  const mirrorSet = useMemo(() => new Set(propertyMirrors ?? []), [propertyMirrors]);
  const isMirrored = (pid: string): boolean => mirrorSet.has(pid) || isHardcodedMirrorProp(pid);
  // Identifiers one item declares "shared with" (P4070) the other: Wikidata's
  // own statement that a single id value covers both items, so agreeing on it
  // is not evidence of a duplicate. Flagged and sunk like mirrored ids.
  const sharedSet = useMemo(() => sharedIdentifierProps(from, into), [from, into]);
  const isShared = (pid: string): boolean => sharedSet.has(pid);
  // Either kind of non-evidence identifier sinks to the bottom of its group.
  const isDiscounted = (r: { kind: string; key: string }): boolean =>
    r.kind === "statement" && (isMirrored(r.key) || isShared(r.key));

  // Best display name for a column header, shown de-emphasized next to the QID
  // (e.g. "Q134990310 (HYPER METEOR)"). Omitted when the item carries no label.
  const nameOf = (item: Item): string | undefined =>
    item.labels.en ?? item.labels.mul ?? Object.values(item.labels)[0];
  const fromName = nameOf(from);
  const intoName = nameOf(into);
  const [hidden, setHidden] = useState<Record<RowStatus, boolean>>({
    identical: false,
    similar: false,
    distinct: false,
    "one-sided": false,
  });

  const rows = useMemo(
    // Descriptions are shown directly under each item's name (see ItemPlate), so
    // drop them from the compared-properties groups rather than listing them
    // again as identical/similar/distinct rows.
    () =>
      buildRows(from, into, propertyLabels, valueLabels).filter(
        (r) => !r.key.startsWith("description:"),
      ),
    [from, into, propertyLabels, valueLabels],
  );
  // Auto-ignored conflicts (a differing description) are handled by the merge
  // flow, so they aren't shown as blockers the user must resolve.
  const blockers = rows.filter((r) => r.blocker && !isAutoIgnoredConflict(r.key));
  const counts = rows.reduce((acc, r) => ({ ...acc, [r.status]: acc[r.status] + 1 }), {
    identical: 0,
    similar: 0,
    distinct: 0,
    "one-sided": 0,
  } as Record<RowStatus, number>);

  return (
    <div className="mc">
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
            {blockers.length === 1 ? "1 conflict blocks" : `${blockers.length} conflicts block`} the
            merge
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
        // P31 first, then Wikidata-sourced (mirrored) and declared-shared (P4070)
        // identifiers sink to the bottom — they're weak evidence either way;
        // everything else keeps its build order (terms, sitelinks, statements).
        // Array.sort is stable, so rows within a rank stay in build order.
        const rank = (r: (typeof rows)[number]): number =>
          r.key === "P31" ? -1 : isDiscounted(r) ? 1 : 0;
        const groupRows = rows
          .filter((r) => r.status === g.status)
          .sort((x, y) => rank(x) - rank(y));
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
                      <th className="col-a">
                        <a
                          className="col-id"
                          href={wikiPageUrl(from.id)}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {from.id}
                        </a>
                        {fromName && <span className="col-name">{fromName}</span>}
                      </th>
                      <th className="col-b">
                        <a
                          className="col-id"
                          href={wikiPageUrl(into.id)}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {into.id}
                        </a>
                        {intoName && <span className="col-name">{intoName}</span>}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {groupRows.map((r) => {
                      // External-id rows link their values via the property's
                      // formatter URL; other kinds have none.
                      const formatter =
                        r.kind === "statement" ? propertyFormatters?.[r.key] : undefined;
                      return (
                        <tr
                          key={r.key}
                          className={
                            [
                              r.blocker && !isAutoIgnoredConflict(r.key) ? "is-blocker" : "",
                              isDiscounted(r) ? "is-discounted" : "",
                            ]
                              .filter(Boolean)
                              .join(" ") || undefined
                          }
                        >
                          <td className="col-prop">
                            <div className="prop-label">{r.label}</div>
                            <div className="prop-key">
                              {r.kind === "statement" ? (
                                <a
                                  href={wikiPageUrl(`Property:${r.key}`)}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                >
                                  {r.key}
                                </a>
                              ) : (
                                r.kind
                              )}
                              {r.kind === "statement" && isMirrored(r.key) && (
                                <span
                                  className="prop-mirror"
                                  title="Identifier is for a database based on Wikidata, these may be distinct values but they tell us nothing about whether these are distinct entities."
                                >
                                  ↺ Wikidata-sourced
                                </span>
                              )}
                              {r.kind === "statement" && isShared(r.key) && (
                                <span
                                  className="prop-shared"
                                  title="Wikidata marks this identifier as shared between these two items (P4070 “identifier shared with”): one id legitimately covers both, so agreeing on it tells us nothing about whether they are the same entity."
                                >
                                  ⇄ shared identifier
                                </span>
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
                              r.a.map((v, i) => <ValueChip key={i} v={v} formatter={formatter} />)
                            )}
                          </td>
                          <td className="col-b">
                            {r.b.length === 0 ? (
                              <span className="none">—</span>
                            ) : (
                              r.b.map((v, i) => <ValueChip key={i} v={v} formatter={formatter} />)
                            )}
                          </td>
                        </tr>
                      );
                    })}
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
