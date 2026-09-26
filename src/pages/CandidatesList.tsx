import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { fetch, FetchError } from "../lib/client.ts";
import { useAuth } from "../lib/auth-context.ts";
import AuthBar from "../AuthBar.tsx";
import Dialog from "../Dialog.tsx";
import { LogoMark } from "../Logo.tsx";
import { IMPORT_CLASS_GROUPS, IMPORT_CLASS_OPTIONS } from "../lib/import-classes.ts";
import { rememberListSearch } from "../lib/list-state.ts";
import { useDismissableMenu } from "../lib/use-dismissable-menu.ts";
import {
  CANDIDATE_SORTS,
  CANDIDATE_STATUSES,
  type CandidateListResponse,
  type CandidateSort,
  type CandidateStatus,
  type CandidateDismissResponse,
  type CandidateSummary,
} from "../lib/api-types.ts";

const PAGE_SIZE = 25;

const SORT_LABELS: Record<CandidateSort, string> = {
  confidence: "Confidence",
  detectedAt: "Recently found",
};

// Instance-of (P31) types to offer as quick filters: exactly the classes the
// dump import brings in, grouped by WikiProject. The filter still accepts any
// QIDs via the URL `type` param (comma-separated) — this is just the prefilled
// dropdown. Picking a WikiProject just checks all of its types.
const P31_OPTIONS = IMPORT_CLASS_OPTIONS;

function confidenceTier(confidence: number): "identical" | "similar" | "distinct" {
  if (confidence >= 0.6) return "identical";
  if (confidence >= 0.4) return "similar";
  return "distinct";
}

function oneOf<T extends string>(options: readonly T[], value: string | null, fallback: T): T {
  return options.includes(value as T) ? (value as T) : fallback;
}

/** A type's display name: its preset label, or the bare QID. */
function typeLabel(qid: string): string {
  return P31_OPTIONS.find((o) => o.qid === qid)?.label ?? qid;
}

/** The filter's closed-state text: a WikiProject's name when exactly its types are picked. */
function typeSummary(selected: string[]): string {
  if (selected.length === 0) return "All types";
  const group = IMPORT_CLASS_GROUPS.find(
    (g) =>
      g.classes.length > 1 &&
      g.classes.length === selected.length &&
      g.classes.every((c) => selected.includes(c.qid)),
  );
  if (group) return group.name;
  return selected.length === 1 ? typeLabel(selected[0]) : `${selected.length} types`;
}

/**
 * Multi-select for the instance-of filter: a dropdown of checkboxes, grouped
 * by WikiProject. A group's own checkbox (indeterminate when partly picked)
 * toggles all of its types. None checked means all types. QIDs from the URL
 * that aren't presets are listed too, so they can be seen and unchecked.
 */
function TypeFilter({
  selected,
  onChange,
}: {
  selected: string[];
  onChange: (types: string[]) => void;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  useDismissableMenu(ref);
  const custom = selected
    .filter((qid) => !P31_OPTIONS.some((o) => o.qid === qid))
    .map((qid) => ({ qid, label: qid }));
  const groups =
    custom.length > 0
      ? [...IMPORT_CLASS_GROUPS, { name: "Custom", classes: custom }]
      : IMPORT_CLASS_GROUPS;
  const order = groups.flatMap((g) => g.classes.map((c) => c.qid));
  // Keep the list in option order so the URL doesn't depend on click order.
  const set = (qids: readonly string[], on: boolean) =>
    onChange(order.filter((q) => (qids.includes(q) ? on : selected.includes(q))));
  return (
    <div className="field">
      <span id="type-filter-label">Type</span>
      <details className="menu type-filter" ref={ref}>
        <summary aria-labelledby="type-filter-label type-filter-value">
          <span id="type-filter-value" className="filter-summary">
            {typeSummary(selected)}
          </span>{" "}
          ▾
        </summary>
        <div className="menu-panel type-filter-panel">
          <button type="button" onClick={() => onChange([])} disabled={selected.length === 0}>
            All types
          </button>
          {groups.map((g) => {
            const qids = g.classes.map((c) => c.qid);
            const picked = qids.filter((q) => selected.includes(q)).length;
            const all = picked === qids.length;
            return (
              <div key={g.name} className="type-filter-group" role="group" aria-label={g.name}>
                <label className="type-filter-group-label">
                  <input
                    type="checkbox"
                    checked={all}
                    ref={(el) => {
                      if (el) el.indeterminate = picked > 0 && !all;
                    }}
                    onChange={() => set(qids, !all)}
                  />
                  {g.name}
                </label>
                {g.classes.map((c) => (
                  <label key={c.qid} className="type-filter-type">
                    <input
                      type="checkbox"
                      checked={selected.includes(c.qid)}
                      onChange={() => set([c.qid], !selected.includes(c.qid))}
                    />
                    {c.label}
                  </label>
                ))}
              </div>
            );
          })}
        </div>
      </details>
    </div>
  );
}

export default function CandidatesList() {
  const [params, setParams] = useSearchParams();
  const { user, loading: authLoading } = useAuth();
  const q = params.get("q") ?? "";
  // Username of either item's creator (see item_creations); empty means anyone.
  const creator = params.get("creator") ?? "";
  // Hide pairs flagged with a merge-blocking conflict; off by default.
  const noBlockers = params.get("noBlockers") === "1";
  // Set by the OAuth callback when the login didn't complete (?auth=denied|failed).
  // Read once into state and then stripped from the URL, so the alert doesn't
  // survive every filter change and a retried login doesn't return to it.
  const [authOutcome] = useState(() => params.get("auth"));
  useEffect(() => {
    if (!params.has("auth")) return;
    const next = new URLSearchParams(params);
    next.delete("auth");
    setParams(next, { replace: true });
  }, [params, setParams]);
  const status = oneOf<CandidateStatus>(CANDIDATE_STATUSES, params.get("status"), "open");
  const sort = oneOf<CandidateSort>(CANDIDATE_SORTS, params.get("sort"), "confidence");
  // Comma-separated instance-of QIDs; empty means every type.
  const typeParam = params.get("type") ?? "";
  const types = typeParam.split(",").filter(Boolean);
  const page = Math.max(1, Number(params.get("page")) || 1);
  // The languages the user reads (settings page) filter the list unless the
  // URL says `lang=any`. Logged out, or with none set, nothing is filtered.
  const userLangs = user?.languages ?? [];
  const anyLanguage = params.get("lang") === "any";
  const langFilter = anyLanguage ? "" : userLangs.join(",");
  const hasFilters =
    q !== "" ||
    creator !== "" ||
    status !== "open" ||
    types.length > 0 ||
    anyLanguage ||
    noBlockers;
  // Phones only: the filter fields fold behind a toggle (CSS hides it on wider screens).
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filterSummary = [
    status[0].toUpperCase() + status.slice(1),
    typeSummary(types),
    creator && `by ${creator}`,
    noBlockers && "No blockers",
    userLangs.length > 0 && (anyLanguage ? "Any language" : userLangs.join(", ")),
  ]
    .filter(Boolean)
    .join(" · ");

  // Remember the current view so the detail page's "Back to candidates" link
  // returns here. The one-shot `auth` param is stripped (and re-recorded) above.
  useEffect(() => {
    if (params.has("auth")) return;
    rememberListSearch(params.toString());
  }, [params]);

  const [data, setData] = useState<CandidateListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Candidates dismissed in-place this session, hidden without a full refetch.
  const [dismissedIds, setDismissedIds] = useState<Set<number>>(new Set());
  useEffect(() => {
    // Wait for the session: it decides the language filter, and fetching
    // before it lands would flash the unfiltered list.
    if (authLoading) return;
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      setDismissedIds(new Set());
      const query: Record<string, string> = {
        status,
        sort,
        page: String(page),
        pageSize: String(PAGE_SIZE),
      };
      if (q) query.q = q;
      if (typeParam) query.type = typeParam;
      if (creator) query.creator = creator;
      if (noBlockers) query.noBlockers = "1";
      if (langFilter) query.lang = langFilter;
      try {
        const res = await fetch("/api/candidates", { query });
        if (!cancelled) setData(res as CandidateListResponse);
      } catch (e: unknown) {
        if (!cancelled) {
          setError(e instanceof FetchError ? `Request failed (${e.status})` : "Request failed");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [q, creator, noBlockers, status, sort, typeParam, page, langFilter, authLoading]);

  // Dismiss straight from the list; the row hides itself on success.
  async function dismissCandidate(id: number): Promise<void> {
    const res = await fetch("/api/candidates/:id/dismiss", {
      method: "POST",
      params: { id: String(id) },
    });
    void (res as CandidateDismissResponse);
    setDismissedIds((prev) => new Set(prev).add(id));
  }

  // Merge params; any filter change resets pagination unless page is set explicitly.
  function update(next: Record<string, string | undefined>) {
    const merged = new URLSearchParams(params);
    for (const [key, value] of Object.entries(next)) {
      if (value === undefined || value === "") merged.delete(key);
      else merged.set(key, value);
    }
    if (!("page" in next)) merged.delete("page");
    setParams(merged, { replace: true });
  }

  // Pager buttons sit below the table, so jump back to the top of the new page.
  function goToPage(target: number) {
    update({ page: String(target) });
    window.scrollTo({ top: 0 });
  }

  const visible = (data?.candidates ?? []).filter((c) => !dismissedIds.has(c.id));
  const total = data?.total ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const firstRow = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const lastRow = Math.min(total, page * PAGE_SIZE);

  // Per-route <title> reflecting the active filters. The default (open) view is
  // just the app name; other statuses carry their own "<Status> candidates"
  // tail. A search term leads. React 19 hoists this into <head>.
  const titleTail =
    status === "open"
      ? "M&A: A Wikidata Merge Assistant"
      : `${status[0].toUpperCase() + status.slice(1)} candidates`;
  const titleParts = [...(q ? [`“${q}”`] : []), ...(creator ? [`by ${creator}`] : [])];
  const pageTitle = [...titleParts, titleTail].join(" · ");

  return (
    <main className="mc">
      <title>{pageTitle}</title>
      <header className="list-head">
        <div className="list-head-row">
          <h1 className="list-title">
            <LogoMark />
            <span className="list-title-text">
              Mergers &amp; Acquisitions
              <span className="list-title-sub">A Wikidata Merge Assistant</span>
            </span>
          </h1>
          <div className="head-actions">
            <Link className="head-link" to="/leaderboard">
              Leaderboard
            </Link>
            <AuthBar />
          </div>
        </div>
        {authOutcome === "denied" && (
          <p className="list-msg is-error" role="alert">
            Login cancelled: the authorization request was declined by Wikidata.
          </p>
        )}
        {authOutcome === "failed" && (
          <p className="list-msg is-error" role="alert">
            Login failed while talking to Wikidata. Try again; if it keeps failing, the OAuth
            consumer may be misconfigured.
          </p>
        )}
      </header>

      <form
        className={filtersOpen ? "list-controls filters-open" : "list-controls"}
        onSubmit={(e) => {
          e.preventDefault();
          const form = new FormData(e.currentTarget);
          const text = (name: string) => {
            const value = form.get(name);
            return (typeof value === "string" ? value : "").trim();
          };
          update({ q: text("q"), creator: text("creator") });
        }}
      >
        <input
          // Uncontrolled: `key={q}` re-mounts it when the URL query changes
          // (e.g. via back/forward or Clear) so it stays in sync without a
          // state-sync effect.
          key={q}
          className="search-input"
          type="search"
          name="q"
          defaultValue={q}
          placeholder="Search by label…"
          aria-label="Search candidates by label"
        />
        <button
          type="button"
          className="filters-toggle"
          aria-expanded={filtersOpen}
          onClick={() => setFiltersOpen((open) => !open)}
        >
          <span className="filters-toggle-label">Filters</span>
          <span className="filters-toggle-summary">{filterSummary}</span>
          <span className="filters-toggle-caret" aria-hidden="true">
            ▾
          </span>
        </button>
        <label className="field">
          <span>Status</span>
          <select value={status} onChange={(e) => update({ status: e.target.value })}>
            {/* "merging" is a transient in-flight state that's almost never
                populated, so it's left out of the filter to keep it uncluttered. */}
            {CANDIDATE_STATUSES.filter((s) => s !== "merging").map((s) => (
              <option key={s} value={s}>
                {s[0].toUpperCase() + s.slice(1)}
              </option>
            ))}
          </select>
        </label>

        <TypeFilter selected={types} onChange={(next) => update({ type: next.join(",") })} />

        {/* Counts only filters changed from their defaults; the saved
            languages are the default, so only `lang=any` counts. */}
        <MoreFilters active={[creator !== "", noBlockers, anyLanguage].filter(Boolean).length}>
          <label className="field">
            <span>Created by</span>
            <input
              // Uncontrolled and re-mounted on URL changes, like the search box.
              key={creator}
              className="creator-input"
              type="search"
              name="creator"
              defaultValue={creator}
              placeholder="Username"
              title="Pairs where either item was created by this Wikidata user"
            />
          </label>
          <label className="field field-check">
            <input
              type="checkbox"
              checked={noBlockers}
              onChange={(e) => update({ noBlockers: e.target.checked ? "1" : undefined })}
            />
            <span>Exclude pairs with blockers</span>
          </label>
          {user && <LanguageFilter languages={userLangs} any={anyLanguage} update={update} />}
        </MoreFilters>

        <div className="list-actions">
          {/* Shown while a refetch is in flight; the stale rows stay visible
              (dimmed) underneath instead of blanking the table. */}
          {loading && data && <Spinner label="Updating…" />}
          {/* Clears the filters (search, creator, blockers, status, type, language) but keeps the sort. */}
          {hasFilters && (
            <button
              type="button"
              className="btn-clear"
              onClick={() =>
                update({
                  q: undefined,
                  creator: undefined,
                  noBlockers: undefined,
                  status: undefined,
                  type: undefined,
                  lang: undefined,
                })
              }
            >
              Clear filters
            </button>
          )}
          <button type="submit">Search</button>
        </div>
      </form>

      {error && (
        <p className="list-msg is-error" role="alert">
          {error}
        </p>
      )}
      {loading && !data && (
        <p className="list-msg">
          <Spinner label="Loading…" />
        </p>
      )}
      {data && visible.length === 0 && !loading && (
        <p className="list-msg">
          {hasFilters || langFilter
            ? "No candidates for these filters, please modify your filters."
            : "No open candidates yet. They appear here once the hunt job has scored some pairs."}
        </p>
      )}

      {data && visible.length > 0 && (
        <>
          {/* Ordering sits with the results it orders, apart from the filters. */}
          <div className="results-bar">
            <span className="results-count">
              {total.toLocaleString()} {total === 1 ? "candidate" : "candidates"}
            </span>
            <label className="results-sort">
              <span>Sort by</span>
              <select value={sort} onChange={(e) => update({ sort: e.target.value })}>
                {CANDIDATE_SORTS.map((s) => (
                  <option key={s} value={s}>
                    {SORT_LABELS[s]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="ledger-wrap" aria-busy={loading} data-stale={loading || undefined}>
            <table className="ledger candidates">
              <thead>
                <tr>
                  <th className="col-pair">Candidate</th>
                  <th className="col-conf">Confidence</th>
                  <th className="col-flags">Flags</th>
                  <th className="col-actions" />
                </tr>
              </thead>
              <tbody>
                {visible.map((c) => (
                  <CandidateRowView
                    key={c.id}
                    candidate={c}
                    onDismiss={dismissCandidate}
                    canDismiss={user !== null}
                  />
                ))}
              </tbody>
            </table>
          </div>

          <nav className="pager" aria-label="Pagination">
            <button type="button" disabled={page <= 1} onClick={() => goToPage(page - 1)}>
              ← Prev
            </button>
            <span className="pager-info">
              {firstRow}–{lastRow} of {total}
            </span>
            <button type="button" disabled={page >= lastPage} onClick={() => goToPage(page + 1)}>
              Next →
            </button>
          </nav>
          <p className="list-warning" role="note">
            Reminder: Always review before merging.
          </p>
        </>
      )}

      <footer className="site-footer">
        <a
          href="https://github.com/connorshea/mergers-and-acquisitions"
          target="_blank"
          rel="noreferrer"
        >
          Source code on GitHub
        </a>
        <span className="site-footer-sep" aria-hidden="true">
          {" · "}
        </span>
        <a
          href="https://www.wikidata.org/w/index.php?tagfilter=OAuth+CID%3A+19397&enhanced=1&title=Special%3ARecentChanges&urlversion=2"
          target="_blank"
          rel="noreferrer"
        >
          View Recent Changes from this app
        </a>
      </footer>
    </main>
  );
}

/**
 * The less-used filters (creator, blockers, languages) in a dropdown panel, so the main
 * row stays on one line. The button shows how many of them are set. It sits inside the list's form: the creator box
 * submits with it, on Enter or the panel's Apply button.
 */
function MoreFilters({ active, children }: { active: number; children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useDismissableMenu(ref);
  return (
    <div className="field">
      <details className="menu type-filter more-filters" ref={ref}>
        <summary aria-label={active > 0 ? `More filters, ${active} set` : "More filters"}>
          More filters
          {active > 0 && (
            <span className="filter-count" aria-hidden="true">
              {active}
            </span>
          )}{" "}
          ▾
        </summary>
        <div className="menu-panel more-filters-panel">
          {children}
          <button type="submit" className="more-filters-apply">
            Apply
          </button>
        </div>
      </details>
    </div>
  );
}

/**
 * The reader-language filter: the user's languages (from settings) or any
 * language, with a link beside the heading to choose or edit them. Until some
 * are chosen there's nothing to pick between, so it only says so.
 */
function LanguageFilter({
  languages,
  any,
  update,
}: {
  languages: string[];
  any: boolean;
  update: (next: Record<string, string | undefined>) => void;
}) {
  const hasLanguages = languages.length > 0;
  return (
    <div className="field">
      <span className="field-head">
        {hasLanguages ? <label htmlFor="language-filter">Languages</label> : <span>Languages</span>}
        <Link to="/settings">Configure</Link>
      </span>
      {hasLanguages ? (
        <select
          id="language-filter"
          value={any ? "any" : "mine"}
          onChange={(e) => update({ lang: e.target.value === "any" ? "any" : undefined })}
          title="Hide pairs that need a language you don't read to review"
        >
          <option value="mine">Mine ({languages.join(", ")})</option>
          <option value="any">Any</option>
        </select>
      ) : (
        <span className="field-note">Any language</span>
      )}
    </div>
  );
}

/** A small inline spinner with a visible label, announced politely to screen readers. */
function Spinner({ label }: { label: string }) {
  return (
    <span className="spinner" role="status">
      <span className="spinner-ring" aria-hidden="true" />
      {label}
    </span>
  );
}

function CandidateRowView({
  candidate: c,
  onDismiss,
  canDismiss,
}: {
  candidate: CandidateSummary;
  onDismiss: (id: number) => Promise<void>;
  /** False when logged out: dismissing needs an account. */
  canDismiss: boolean;
}) {
  const pct = Math.round(c.confidence * 100);
  // "same instance of (P31)" is already shown as the type pill (and is true of
  // nearly every pair), so it's noise in the compact list summary — drop it
  // here. The full reason list still shows on the detail view.
  const summaryReasons = c.reasons.filter((r) => !r.includes("instance of"));
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [confirming, setConfirming] = useState(false);

  async function dismiss() {
    setConfirming(false);
    setBusy(true);
    setFailed(false);
    try {
      await onDismiss(c.id);
    } catch {
      setFailed(true);
      setBusy(false);
    }
  }

  return (
    <tr>
      <td className="col-pair">
        {c.sharedType && (
          <span
            className="pair-type"
            title={`Both items are an instance of ${c.sharedType.label ?? c.sharedType.qid} (${c.sharedType.qid})`}
          >
            {c.sharedType.label ?? c.sharedType.qid}
          </span>
        )}
        <Link className="pair-link" to={`/candidates/${c.id}`}>
          <span className="pair-side">
            {c.fromLabel ?? c.fromQid} <span className="pair-qid">{c.fromQid}</span>
          </span>
          <span className="pair-arrow" aria-hidden="true">
            →
          </span>
          <span className="pair-side">
            {c.intoLabel ?? c.intoQid} <span className="pair-qid">{c.intoQid}</span>
          </span>
        </Link>
        {summaryReasons.length > 0 && (
          <div className="pair-reasons">{summaryReasons.join(" · ")}</div>
        )}
      </td>
      <td className="col-conf">
        <span
          className={`confidence conf-${confidenceTier(c.confidence)}`}
          title={`${c.confidence.toFixed(3)} confidence`}
        >
          {pct}%
        </span>
      </td>
      <td className="col-flags">
        {c.hasBlocker && (
          <span className="flag flag-blocker" title="Has a conflict that blocks merging">
            blocker
          </span>
        )}
        {c.status !== "open" && <span className="flag flag-status">{c.status}</span>}
      </td>
      <td className="col-actions">
        {c.status === "open" && (
          <button
            type="button"
            className="btn-row-dismiss"
            onClick={() => setConfirming(true)}
            disabled={busy || !canDismiss}
            title={canDismiss ? "Mark this pair as not a duplicate" : "Log in to dismiss"}
          >
            {busy ? "…" : failed ? "Retry" : "Dismiss"}
          </button>
        )}
        {confirming && (
          <Dialog title="Dismiss this candidate?" onClose={() => setConfirming(false)}>
            <p className="modal-body">
              <strong>
                {c.fromLabel ?? c.fromQid} ({c.fromQid})
              </strong>{" "}
              and{" "}
              <strong>
                {c.intoLabel ?? c.intoQid} ({c.intoQid})
              </strong>{" "}
              leave the open list. Nothing is changed on Wikidata, and the pair can be reopened from
              its page.
            </p>
            <div className="modal-actions">
              <button type="button" className="btn-secondary" onClick={() => setConfirming(false)}>
                Cancel
              </button>
              <button type="button" className="btn-primary" onClick={dismiss}>
                Dismiss
              </button>
            </div>
          </Dialog>
        )}
      </td>
    </tr>
  );
}
