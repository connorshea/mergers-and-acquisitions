import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { fetch, FetchError } from "../lib/client";
import MergeCandidates from "../MergeCandidates";
import type {
  CandidateDetailResponse,
  CandidateDismissResponse,
  CandidateReopenResponse,
} from "../lib/api-types";

// Detail view for one candidate: a summary bar (confidence, reasons, dismiss)
// over the full field-by-field comparison. The API returns the pair already
// ordered (from = merged away, into = survivor), so it feeds straight into
// MergeCandidates without re-ordering.
export default function CandidateDetail() {
  const { id } = useParams();
  const [data, setData] = useState<CandidateDetailResponse | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [dismissing, setDismissing] = useState(false);
  // Which "not implemented yet" dialog is open, if any. Merge and
  // "mark as different from" are placeholders until those flows are built.
  const [dialog, setDialog] = useState<"merge" | "different" | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/candidates/:id", { params: { id: id! } });
        if (cancelled) return;
        const detail = res as CandidateDetailResponse;
        setData(detail);
        setStatus(detail.candidate.status);
      } catch (e: unknown) {
        if (cancelled) return;
        setError(
          e instanceof FetchError
            ? e.status === 404
              ? "Candidate not found."
              : `Request failed (${e.status}).`
            : "Request failed.",
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [id]);

  async function dismiss() {
    if (!id) return;
    setDismissing(true);
    try {
      const res = await fetch("/api/candidates/:id/dismiss", { method: "POST", params: { id } });
      setStatus((res as CandidateDismissResponse).candidate.status);
    } catch (e: unknown) {
      setError(e instanceof FetchError ? `Dismiss failed (${e.status}).` : "Dismiss failed.");
    } finally {
      setDismissing(false);
    }
  }

  async function reopen() {
    if (!id) return;
    setDismissing(true);
    try {
      const res = await fetch("/api/candidates/:id/reopen", { method: "POST", params: { id } });
      setStatus((res as CandidateReopenResponse).candidate.status);
    } catch (e: unknown) {
      setError(e instanceof FetchError ? `Reopen failed (${e.status}).` : "Reopen failed.");
    } finally {
      setDismissing(false);
    }
  }

  const candidate = data?.candidate;

  return (
    <>
      <div className="detail-top">
        <nav className="detail-nav">
          <Link className="detail-back" to="/">
            ← Back to candidates
          </Link>
          <div className="detail-siblings">
            {data?.prevId != null ? (
              <Link className="sibling-link" to={`/candidates/${data.prevId}`} rel="prev">
                ← Prev
              </Link>
            ) : (
              <span className="sibling-link is-disabled">← Prev</span>
            )}
            {data?.nextId != null ? (
              <Link className="sibling-link" to={`/candidates/${data.nextId}`} rel="next">
                Next →
              </Link>
            ) : (
              <span className="sibling-link is-disabled">Next →</span>
            )}
          </div>
        </nav>

        {loading && <p className="list-msg">Loading…</p>}
        {error && !loading && (
          <p className="list-msg is-error" role="alert">
            {error}
          </p>
        )}

        {candidate && (
          <div className="detail-bar">
            <div className="detail-score">
              <span
                className={`confidence conf-${
                  candidate.confidence >= 0.6
                    ? "identical"
                    : candidate.confidence >= 0.4
                      ? "similar"
                      : "distinct"
                }`}
              >
                {Math.round(candidate.confidence * 100)}%
              </span>
              <span className="detail-score-label">confidence</span>
            </div>
            {candidate.reasons.length > 0 && (
              <ul className="detail-reasons">
                {candidate.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            )}
            <div className="detail-actions">
              {/* Merge / "different from" only make sense on an open pair; once
                  it's dismissed or merged they're hidden. */}
              {(!status || status === "open") && (
                <>
                  <button type="button" className="btn-merge" onClick={() => setDialog("merge")}>
                    Merge
                  </button>
                  <button
                    type="button"
                    className="btn-different"
                    onClick={() => setDialog("different")}
                  >
                    Mark as different from
                  </button>
                </>
              )}
              {status && status !== "open" ? (
                <>
                  <span className="flag flag-status">{status}</span>
                  {status === "dismissed" && (
                    <button
                      type="button"
                      className="btn-dismiss"
                      onClick={reopen}
                      disabled={dismissing}
                    >
                      {dismissing ? "Reopening…" : "Un-dismiss"}
                    </button>
                  )}
                </>
              ) : (
                <button
                  type="button"
                  className="btn-dismiss"
                  onClick={dismiss}
                  disabled={dismissing}
                >
                  {dismissing ? "Dismissing…" : "Dismiss"}
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {data && candidate && (
        <MergeCandidates
          from={data.from}
          into={data.into}
          propertyLabels={data.propertyLabels}
          propertyFormatters={data.propertyFormatters}
          propertyMirrors={data.propertyMirrors}
          valueLabels={data.valueLabels}
        />
      )}

      {dialog && (
        <NotImplementedDialog
          title={dialog === "merge" ? "Merge items" : "Mark as different from"}
          body={
            dialog === "merge"
              ? "Applying merges via Wikidata (wbmergeitems) isn't implemented yet."
              : "Recording a “different from” (P1889) statement isn't implemented yet."
          }
          onClose={() => setDialog(null)}
        />
      )}
    </>
  );
}

// A minimal modal used for the not-yet-built merge / "different from" actions.
// Closes on backdrop click, the Close button, or Escape.
function NotImplementedDialog({
  title,
  body,
  onClose,
}: {
  title: string;
  body: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="modal-title">{title}</h2>
        <p className="modal-body">{body}</p>
        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
