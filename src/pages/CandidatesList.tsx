import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { fetch, FetchError } from "void/client";
import {
  CANDIDATE_SORTS,
  CANDIDATE_STATUSES,
  type CandidateListResponse,
  type CandidateSort,
  type CandidateStatus,
  type CandidateDismissResponse,
  type CandidateSummary,
  type HuntTriggerResponse,
  type PropertiesSyncResponse,
} from "../lib/api-types";

const PAGE_SIZE = 25;

const SORT_LABELS: Record<CandidateSort, string> = {
  confidence: "Confidence",
  detectedAt: "Recently found",
};

function confidenceTier(confidence: number): "identical" | "similar" | "distinct" {
  if (confidence >= 0.6) return "identical";
  if (confidence >= 0.4) return "similar";
  return "distinct";
}

function oneOf<T extends string>(options: readonly T[], value: string | null, fallback: T): T {
  return options.includes(value as T) ? (value as T) : fallback;
}

export default function CandidatesList() {
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const status = oneOf<CandidateStatus>(CANDIDATE_STATUSES, params.get("status"), "open");
  const sort = oneOf<CandidateSort>(CANDIDATE_SORTS, params.get("sort"), "confidence");
  const page = Math.max(1, Number(params.get("page")) || 1);

  const [data, setData] = useState<CandidateListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Bumping this refetches the list without changing any URL param — used to
  // pull in candidates the hunt job produced after it was triggered.
  const [reloadKey, setReloadKey] = useState(0);
  const [hunt, setHunt] = useState<{ running: boolean; note: string | null }>({
    running: false,
    note: null,
  });
  const [syncing, setSyncing] = useState(false);
  // Candidates dismissed in-place this session, hidden without a full refetch.
  const [dismissedIds, setDismissedIds] = useState<Set<number>>(new Set());

  useEffect(() => {
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
  }, [q, status, sort, page, reloadKey]);

  async function runHunt() {
    setHunt({ running: true, note: null });
    try {
      const res = await fetch("/api/hunt", { method: "POST" });
      setHunt({ running: false, note: (res as HuntTriggerResponse).message });
      // The queue processes asynchronously; refetch shortly so freshly scored
      // pairs show up without a manual reload.
      setTimeout(() => setReloadKey((k) => k + 1), 2500);
    } catch (e: unknown) {
      setHunt({
        running: false,
        note: e instanceof FetchError ? `Hunt failed (${e.status}).` : "Hunt failed.",
      });
    }
  }

  async function syncProperties() {
    setSyncing(true);
    setHunt({ running: false, note: null });
    try {
      const res = await fetch("/api/properties/sync", { method: "POST" });
      const { synced } = res as PropertiesSyncResponse;
      setHunt({ running: false, note: `Synced ${synced.toLocaleString()} property names.` });
    } catch (e: unknown) {
      setHunt({
        running: false,
        note:
          e instanceof FetchError ? `Property sync failed (${e.status}).` : "Property sync failed.",
      });
    } finally {
      setSyncing(false);
    }
  }

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

  const visible = (data?.candidates ?? []).filter((c) => !dismissedIds.has(c.id));
  const total = data?.total ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const firstRow = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const lastRow = Math.min(total, page * PAGE_SIZE);

  return (
    <main className="mc">
      <header className="list-head">
        <div className="list-head-row">
          <h1>Merge candidates</h1>
          <div className="head-actions">
            <button
              type="button"
              className="btn-secondary"
              onClick={syncProperties}
              disabled={syncing}
              title="Fetch human-readable property names from Wikidata"
            >
              {syncing ? "Syncing names…" : "Sync property names"}
            </button>
            <button type="button" className="btn-hunt" onClick={runHunt} disabled={hunt.running}>
              {hunt.running ? "Starting hunt…" : "Run hunt"}
            </button>
          </div>
        </div>
        <p className="list-sub">
          Ranked pairs of Wikidata video-game items that may be duplicates. Confidence is heuristic;
          always review before merging.
        </p>
        {hunt.note && <p className="list-msg hunt-note">{hunt.note}</p>}
      </header>

      <div className="list-controls">
        <form
          className="search"
          onSubmit={(e) => {
            e.preventDefault();
            const value = new FormData(e.currentTarget).get("q");
            update({ q: (typeof value === "string" ? value : "").trim() });
          }}
        >
          <input
            // Uncontrolled: `key={q}` re-mounts it when the URL query changes
            // (e.g. via back/forward) so it stays in sync without a state-sync effect.
            key={q}
            type="search"
            name="q"
            defaultValue={q}
            placeholder="Search by label…"
            aria-label="Search candidates by label"
          />
          <button type="submit">Search</button>
        </form>

        <label className="field">
          <span>Status</span>
          <select value={status} onChange={(e) => update({ status: e.target.value })}>
            {CANDIDATE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s[0].toUpperCase() + s.slice(1)}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Sort</span>
          <select value={sort} onChange={(e) => update({ sort: e.target.value })}>
            {CANDIDATE_SORTS.map((s) => (
              <option key={s} value={s}>
                {SORT_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error && (
        <p className="list-msg is-error" role="alert">
          {error}
        </p>
      )}
      {loading && !data && <p className="list-msg">Loading…</p>}
      {data && visible.length === 0 && !loading && (
        <p className="list-msg">
          No {status} candidates{q ? ` matching “${q}”` : ""}. They appear here once the hunt job
          has scored some pairs.
        </p>
      )}

      {data && visible.length > 0 && (
        <>
          <div className="ledger-wrap">
            <table className="ledger candidates">
              <thead>
                <tr>
                  <th className="col-pair">Candidate</th>
                  <th className="col-conf">Confidence</th>
                  <th className="col-flags">Flags</th>
                  <th className="col-when">Found</th>
                  <th className="col-actions" />
                </tr>
              </thead>
              <tbody>
                {visible.map((c) => (
                  <CandidateRowView key={c.id} candidate={c} onDismiss={dismissCandidate} />
                ))}
              </tbody>
            </table>
          </div>

          <nav className="pager" aria-label="Pagination">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => update({ page: String(page - 1) })}
            >
              ← Prev
            </button>
            <span className="pager-info">
              {firstRow}–{lastRow} of {total}
            </span>
            <button
              type="button"
              disabled={page >= lastPage}
              onClick={() => update({ page: String(page + 1) })}
            >
              Next →
            </button>
          </nav>
        </>
      )}
    </main>
  );
}

function CandidateRowView({
  candidate: c,
  onDismiss,
}: {
  candidate: CandidateSummary;
  onDismiss: (id: number) => Promise<void>;
}) {
  const pct = Math.round(c.confidence * 100);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function dismiss() {
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
        {c.reasons.length > 0 && <div className="pair-reasons">{c.reasons.join(" · ")}</div>}
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
      <td className="col-when">{c.detectedAt.slice(0, 10)}</td>
      <td className="col-actions">
        {c.status === "open" && (
          <button
            type="button"
            className="btn-row-dismiss"
            onClick={dismiss}
            disabled={busy}
            title="Mark this pair as not a duplicate"
          >
            {busy ? "…" : failed ? "Retry" : "Dismiss"}
          </button>
        )}
      </td>
    </tr>
  );
}
