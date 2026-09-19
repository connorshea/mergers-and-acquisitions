import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { fetch, FetchError } from "../lib/client.ts";
import { useAuth } from "../lib/auth.tsx";
import { loginUrl } from "../lib/auth-url.ts";
import AuthBar from "../AuthBar.tsx";
import MergeCandidates from "../MergeCandidates.tsx";
import {
  AUTO_IGNORED_CONFLICTS,
  type Item,
  type MergeConflict,
  mergeConflicts,
} from "../lib/compare.ts";
import {
  type CandidateDetailResponse,
  type CandidateDifferentResponse,
  type CandidateDismissResponse,
  type CandidateMergeRequest,
  type CandidateMergeResponse,
  type CandidateReopenResponse,
  type CandidateSummary,
  MERGE_CONFLICT_TYPES,
} from "../lib/api-types.ts";

// Detail view for one candidate: a summary bar (confidence, reasons, actions)
// over the full field-by-field comparison. The API returns the pair already
// ordered (from = merged away, into = survivor), so it feeds straight into
// MergeCandidates without re-ordering. Merge and "different from" go to
// Wikidata through the server, under the logged-in user's account.
export default function CandidateDetail() {
  const { id } = useParams();
  const { user, configured } = useAuth();
  const [data, setData] = useState<CandidateDetailResponse | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [resolution, setResolution] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [dismissing, setDismissing] = useState(false);
  const [dialog, setDialog] = useState<"merge" | "different" | null>(null);
  // The outcome of an edit made from this page, shown until navigation.
  const [outcome, setOutcome] = useState<EditOutcome | null>(null);

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
        setResolution(detail.candidate.resolution);
        setOutcome(null);
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
      applyCandidate((res as CandidateDismissResponse).candidate);
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
      applyCandidate((res as CandidateReopenResponse).candidate);
      setOutcome(null);
    } catch (e: unknown) {
      setError(e instanceof FetchError ? `Reopen failed: ${e.message}` : "Reopen failed.");
    } finally {
      setDismissing(false);
    }
  }

  function applyCandidate(candidate: CandidateSummary) {
    setStatus(candidate.status);
    setResolution(candidate.resolution);
  }

  // Which ignoreconflicts kinds the mirror suggests the merge will need.
  const detectedConflicts = useMemo(
    () => (data ? mergeConflicts(data.from, data.into) : []),
    [data],
  );

  const candidate = data?.candidate;

  // Per-route <title>: the pair once loaded (e.g. "Foo (Q200) → Bar (Q100)"),
  // the candidate id while loading, and "Not found" on a 404. "Merge
  // candidates" is the shared suffix; React 19 hoists this into <head>.
  const titleLead = candidate
    ? `${side(candidate.fromLabel, candidate.fromQid)} → ${side(candidate.intoLabel, candidate.intoQid)}`
    : error === "Candidate not found."
      ? "Not found"
      : `Candidate ${id ?? ""}`.trim();
  const pageTitle = `${titleLead} · Merge candidates`;

  return (
    <>
      <title>{pageTitle}</title>
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
          <AuthBar />
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
                  <li key={r}>
                    <ReasonText text={r} propertyLabels={data?.propertyLabels} />
                  </li>
                ))}
              </ul>
            )}
            <div className="detail-actions">
              {/* Every action edits state (here or on Wikidata) on the user's
                  behalf, so all of them need a login. */}
              {!user && configured && (
                <span className="login-hint">
                  <a href={loginUrl(`/candidates/${id ?? ""}`)}>Log in</a> to act on this pair
                </span>
              )}
              {/* Merge / "different from" only make sense on an open pair; once
                  it's dismissed or merged they're hidden. */}
              {(!status || status === "open") && (
                <>
                  <button
                    type="button"
                    className="btn-merge"
                    onClick={() => setDialog("merge")}
                    disabled={!user}
                    title={user ? undefined : "Log in to merge"}
                  >
                    Merge
                  </button>
                  <button
                    type="button"
                    className="btn-different"
                    onClick={() => setDialog("different")}
                    disabled={!user}
                    title={user ? undefined : "Log in to mark as different"}
                  >
                    Mark as different from
                  </button>
                </>
              )}
              {status && status !== "open" ? (
                <>
                  <span className="flag flag-status">{status}</span>
                  {resolution && <span className="detail-resolution">{resolution}</span>}
                  {/* A merged pair stays merged (it happened on Wikidata); a
                      dismissed one, or a merge claim that was abandoned, can
                      come back. */}
                  {(status === "dismissed" || status === "merging") && (
                    <button
                      type="button"
                      className="btn-dismiss"
                      onClick={reopen}
                      disabled={dismissing || !user}
                      title={user ? undefined : "Log in to reopen"}
                    >
                      {dismissing ? "Reopening…" : status === "dismissed" ? "Un-dismiss" : "Reopen"}
                    </button>
                  )}
                </>
              ) : (
                <button
                  type="button"
                  className="btn-dismiss"
                  onClick={dismiss}
                  disabled={dismissing || !user}
                  title={user ? undefined : "Log in to dismiss"}
                >
                  {dismissing ? "Dismissing…" : "Dismiss"}
                </button>
              )}
            </div>
            {outcome && <EditOutcomePanel outcome={outcome} />}
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

      {dialog === "merge" && data && candidate && id && (
        <MergeDialog
          id={id}
          candidate={candidate}
          from={data.from}
          into={data.into}
          detected={detectedConflicts}
          username={user?.username ?? ""}
          onClose={() => setDialog(null)}
          onDone={(res) => {
            applyCandidate(res.candidate);
            setOutcome({ kind: "merge", res });
            setDialog(null);
          }}
        />
      )}
      {dialog === "different" && candidate && id && (
        <DifferentDialog
          id={id}
          candidate={candidate}
          username={user?.username ?? ""}
          onClose={() => setDialog(null)}
          onDone={(res) => {
            applyCandidate(res.candidate);
            setOutcome({ kind: "different", res });
            setDialog(null);
          }}
        />
      )}
    </>
  );
}

type EditOutcome =
  | { kind: "merge"; res: CandidateMergeResponse }
  | { kind: "different"; res: CandidateDifferentResponse };

/** What an edit made from this page did on Wikidata, with links to the revisions. */
function EditOutcomePanel({ outcome }: { outcome: EditOutcome }) {
  if (outcome.kind === "merge") {
    const { from, into, redirected } = outcome.res;
    return (
      <div className={`edit-result${redirected ? "" : " is-partial"}`} role="status">
        Merged {from.qid} into {into.qid}:{" "}
        <a href={into.url} target="_blank" rel="noreferrer">
          revision {into.revid}
        </a>{" "}
        on {into.qid},{" "}
        <a href={from.url} target="_blank" rel="noreferrer">
          revision {from.revid}
        </a>{" "}
        on {from.qid}.
        {!redirected &&
          ` ${from.qid} was not turned into a redirect (it kept conflicting sitelinks); finish it by hand on Wikidata.`}
      </div>
    );
  }
  const { edits } = outcome.res;
  const partial = edits.some((e) => e.error);
  return (
    <div className={`edit-result${partial ? " is-partial" : ""}`} role="status">
      Marked as different from each other and dismissed.
      <ul>
        {edits.map((e) => (
          <li key={e.qid}>
            {e.qid} → {e.target}:{" "}
            {e.revision ? (
              <a href={e.revision.url} target="_blank" rel="noreferrer">
                revision {e.revision.revid}
              </a>
            ) : e.skipped ? (
              "already had the statement"
            ) : (
              `failed — ${e.error}`
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

const side = (label: string | null, qid: string) => (label ? `${label} (${qid})` : qid);

/** The error from a failed edit, with a re-login link when that is the fix. */
function EditErrorNote({ error, id }: { error: FetchError | Error; id: string }) {
  const code = error instanceof FetchError ? error.code : undefined;
  return (
    <p className="modal-error" role="alert">
      {error.message}
      {code === "login-required" && (
        <>
          {" "}
          <a href={loginUrl(`/candidates/${id}`)}>Log in again</a>.
        </>
      )}
      {code === "conflict" && " Tick the matching override above to proceed anyway."}
    </p>
  );
}

const CONFLICT_COPY: Record<MergeConflict, (from: string, into: string) => ReactNode> = {
  description: (from, into) => (
    <>
      Descriptions differ
      <span className="conflict-hint">
        Keep {into}'s description and drop {from}'s.
      </span>
    </>
  ),
  sitelink: (from, into) => (
    <>
      Sitelinks clash
      <span className="conflict-hint">
        Keep {into}'s pages. {from} keeps its conflicting links, so it will not become a redirect.
      </span>
    </>
  ),
  statement: (from, into) => (
    <>
      The items link to each other
      <span className="conflict-hint">
        Drop the statements on {from} or {into} whose value is the other item.
      </span>
    </>
  ),
};

// Confirm-and-merge dialog: names the pair, offers one override checkbox per
// user-resolvable `ignoreconflicts` kind (marking the ones the mirror predicts),
// and submits. Nothing is ever pre-ticked: an override is sent only because the
// user chose it. Auto-ignored kinds (a differing description) aren't shown as
// overrides — the server always ignores them — but are noted when detected.
function MergeDialog({
  id,
  candidate,
  from,
  into,
  detected,
  username,
  onClose,
  onDone,
}: {
  id: string;
  candidate: CandidateSummary;
  from: Item;
  into: Item;
  detected: MergeConflict[];
  username: string;
  onClose: () => void;
  onDone: (res: CandidateMergeResponse) => void;
}) {
  const [ignore, setIgnore] = useState<MergeConflict[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // The user only resolves conflicts the tool doesn't auto-ignore; a detected
  // auto-ignored conflict (a differing description) is surfaced as a note.
  const manualKinds = MERGE_CONFLICT_TYPES.filter((k) => !AUTO_IGNORED_CONFLICTS.includes(k));
  const autoHandled = detected.filter((k) => AUTO_IGNORED_CONFLICTS.includes(k));

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const body: CandidateMergeRequest = { ignoreConflicts: ignore };
      const res = await fetch("/api/candidates/:id/merge", {
        method: "POST",
        params: { id },
        body,
      });
      onDone(res as CandidateMergeResponse);
    } catch (e: unknown) {
      setError(e instanceof Error ? e : new Error("Merge failed."));
      setBusy(false);
    }
  }

  return (
    <Dialog title="Merge on Wikidata" onClose={busy ? () => {} : onClose} wide>
      <div className="modal-body">
        <p>
          Merge <b>{side(candidate.fromLabel, from.id)}</b> into{" "}
          <b>{side(candidate.intoLabel, into.id)}</b>. {from.id} becomes a redirect and its labels,
          aliases, sitelinks and statements move to {into.id}. The edit is made under your account
          {username ? ` (${username})` : ""} and credits this tool in its summary.
        </p>
        {autoHandled.includes("description") && (
          <p className="modal-note">
            The items have different descriptions; this is handled automatically — {into.id} keeps
            its description and {from.id}'s is dropped.
          </p>
        )}
        <div className="modal-section">
          <p className="modal-section-title">Overrides (leave unticked unless you are sure)</p>
          <ul className="conflict-list">
            {manualKinds.map((kind) => (
              <li key={kind}>
                <label>
                  <input
                    type="checkbox"
                    checked={ignore.includes(kind)}
                    disabled={busy}
                    onChange={(e) =>
                      setIgnore((cur) =>
                        e.target.checked ? [...cur, kind] : cur.filter((k) => k !== kind),
                      )
                    }
                  />
                  <span>
                    {CONFLICT_COPY[kind](from.id, into.id)}
                    {detected.includes(kind) && (
                      <span className="conflict-detected" title="Seen in the mirrored data">
                        detected
                      </span>
                    )}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </div>
        {error && <EditErrorNote error={error} id={id} />}
      </div>
      <div className="modal-actions">
        <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="btn-primary" onClick={submit} disabled={busy}>
          {busy ? "Merging…" : "Merge on Wikidata"}
        </button>
      </div>
    </Dialog>
  );
}

// Confirm dialog for "different from": one P1889 statement in each direction,
// then the candidate is dismissed.
function DifferentDialog({
  id,
  candidate,
  username,
  onClose,
  onDone,
}: {
  id: string;
  candidate: CandidateSummary;
  username: string;
  onClose: () => void;
  onDone: (res: CandidateDifferentResponse) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/candidates/:id/different", { method: "POST", params: { id } });
      onDone(res as CandidateDifferentResponse);
    } catch (e: unknown) {
      setError(e instanceof Error ? e : new Error("Edit failed."));
      setBusy(false);
    }
  }

  return (
    <Dialog title="Mark as different from" onClose={busy ? () => {} : onClose}>
      <div className="modal-body">
        <p>
          Add a <b>different from</b> (P1889) statement on{" "}
          <b>{side(candidate.fromLabel, candidate.fromQid)}</b> pointing at{" "}
          <b>{side(candidate.intoLabel, candidate.intoQid)}</b>, and the reverse, under your account
          {username ? ` (${username})` : ""}. This candidate is then dismissed, and the hunt will
          not pair these two again.
        </p>
        {error && <EditErrorNote error={error} id={id} />}
      </div>
      <div className="modal-actions">
        <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="btn-primary" onClick={submit} disabled={busy}>
          {busy ? "Saving…" : "Add statements"}
        </button>
      </div>
    </Dialog>
  );
}

// Renders one reason line, turning any Wikidata property id (Pxxx) into a
// hoverable token that shows the property's human label. The scorer builds
// reasons without property labels, so they embed raw pids (e.g. "shares external
// identifier: P12813, P5794"); the detail payload carries the labels, so we
// resolve them here for the tooltip while keeping the pid visible.
function ReasonText({
  text,
  propertyLabels,
}: {
  text: string;
  propertyLabels?: Record<string, string>;
}) {
  // Split on pid tokens, keeping them (capturing group) so we can decorate each.
  const parts = text.split(/(\bP\d+\b)/g);
  return (
    <>
      {parts.map((part, i) => {
        const label = /^P\d+$/.test(part) ? propertyLabels?.[part] : undefined;
        return label ? (
          <abbr key={i} className="reason-prop" title={label}>
            {part}
          </abbr>
        ) : (
          <span key={i}>{part}</span>
        );
      })}
    </>
  );
}

// A minimal modal shell. Closes on backdrop click or Escape (callers pass a
// no-op `onClose` while a request is in flight).
function Dialog({
  title,
  wide,
  onClose,
  children,
}: {
  title: string;
  wide?: boolean;
  onClose: () => void;
  children: ReactNode;
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
        className={`modal${wide ? " is-wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="modal-title">{title}</h2>
        {children}
      </div>
    </div>
  );
}
