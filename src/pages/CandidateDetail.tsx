import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { fetch, FetchError } from "void/client";
import MergeCandidates from "../MergeCandidates";
import type { CandidateDetailResponse, CandidateDismissResponse } from "../lib/api-types";

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
              {status && status !== "open" ? (
                <span className="flag flag-status">{status}</span>
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
          valueLabels={data.valueLabels}
        />
      )}
    </>
  );
}
