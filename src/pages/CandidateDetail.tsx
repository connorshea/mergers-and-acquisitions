import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { fetch, FetchError } from "../lib/client.ts";
import { useAuth } from "../lib/auth-context.ts";
import { loginUrl } from "../lib/auth-url.ts";
import { listHref } from "../lib/list-state.ts";
import AuthBar from "../AuthBar.tsx";
import Dialog from "../Dialog.tsx";
import EvidenceLedger from "../EvidenceLedger.tsx";
import { LogoMark } from "../Logo.tsx";
import MergeCandidates from "../MergeCandidates.tsx";
import {
  AUTO_IGNORED_CONFLICTS,
  countDistinctStatements,
  type Item,
  type MergeConflict,
  mergeConflicts,
  plannedSitelinkFixes,
} from "../lib/compare.ts";
import type {
  CandidateCreationsResponse,
  CandidateDetailResponse,
  CandidateDifferentRequest,
  CandidateDifferentResponse,
  CandidateDismissResponse,
  CandidateMergeResponse,
  CandidateReopenResponse,
  CandidateSummary,
  ItemCreation,
} from "../lib/api-types.ts";
import { wikiPageUrl } from "../lib/wiki.ts";

// Detail view for one candidate: a summary card (confidence, evidence, actions)
// over the full field-by-field comparison. The API returns the pair already
// ordered (from = merged away, into = survivor), so it feeds straight into
// MergeCandidates without re-ordering. Merge and "different from" go to
// Wikidata through the server, under the logged-in user's account.
//
// Keyed on the id so moving to another candidate starts from a blank page
// rather than reusing this one's state: the previous pair's data (and its
// Merge / Dismiss buttons) never shows while the next one loads with actions
// aimed at the new id, and a late response to an edit made on the previous
// pair lands on the unmounted page instead of this one.
export default function CandidateDetail() {
  const { id } = useParams();
  return <CandidateDetailPage key={id} id={id} />;
}

function CandidateDetailPage({ id }: { id: string | undefined }) {
  const { user, configured } = useAuth();
  const [data, setData] = useState<CandidateDetailResponse | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [resolution, setResolution] = useState<string | null>(null);
  const [resolvedBy, setResolvedBy] = useState<string | null>(null);
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
        setResolvedBy(detail.candidate.resolvedBy);
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
    setResolvedBy(candidate.resolvedBy);
  }

  // Which merge conflicts the mirror predicts for this pair (see MergeDialog).
  // Who created each item loads separately: it may wait on the Action API for
  // items the nightly job hasn't reached, and the page is usable without it.
  // Kept with the id it belongs to, so a previous pair's never shows.
  const [loadedCreations, setLoadedCreations] = useState<{
    id: string;
    creations: Record<string, ItemCreation>;
  } | null>(null);
  const creations =
    loadedCreations && loadedCreations.id === id ? loadedCreations.creations : undefined;
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    fetch("/api/candidates/:id/creations", { params: { id } })
      .then((res) => {
        if (!cancelled)
          setLoadedCreations({ id, creations: (res as CandidateCreationsResponse).creations });
      })
      .catch(() => {
        // Optional context; the plates just go without it.
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const detectedConflicts = useMemo(
    () => (data?.from && data.into ? mergeConflicts(data.from, data.into) : []),
    [data],
  );
  // Statements that differ, for the ledger to mention when no signal counts
  // against the pair.
  const distinctStatements = useMemo(() => {
    if (!data?.from || !data.into) return 0;
    const mirrors = new Set(data.propertyMirrors ?? []);
    return countDistinctStatements(data.from, data.into, (pid) => mirrors.has(pid));
  }, [data]);

  const candidate = data?.candidate;

  // Per-route <title>: the pair once loaded (e.g. "Foo (Q200) → Bar (Q100)"),
  // the candidate id while loading, and "Not found" on a 404. "Merge
  // candidates" is the shared suffix; React 19 hoists this into <head>.
  const titleLead = candidate
    ? `${side(candidate.fromLabel, candidate.fromQid)} → ${side(candidate.intoLabel, candidate.intoQid)}`
    : error === "Candidate not found."
      ? "Not found"
      : `Candidate ${id ?? ""}`.trim();
  const pageTitle = `${titleLead} · M&A: A Wikidata Merge Assistant`;

  return (
    <>
      <title>{pageTitle}</title>
      <div className="detail-top">
        <nav className="detail-nav">
          <Link className="detail-back" to={listHref()}>
            <LogoMark />← Back to candidates
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

        {/* Every action below edits state (here or on Wikidata) on the user's
            behalf, so all of them need a login. */}
        {candidate && !user && configured && (
          <div className="login-callout">
            <svg
              className="login-callout-icon"
              viewBox="0 0 16 16"
              width="14"
              height="14"
              aria-hidden="true"
            >
              <path
                fill="currentColor"
                d="M8 1a3.5 3.5 0 0 0-3.5 3.5V6H4a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1h-.5V4.5A3.5 3.5 0 0 0 8 1Zm2 5H6V4.5a2 2 0 1 1 4 0V6Z"
              />
            </svg>
            <span>Log in with your Wikimedia account to review this pair.</span>
            <a className="login-callout-btn" href={loginUrl(`/candidates/${id ?? ""}`)}>
              Log in
            </a>
          </div>
        )}
        {candidate && status === "merged" && (resolution || resolvedBy) && (
          <div className="merged-banner" role="status">
            <svg
              className="merged-banner-icon"
              viewBox="0 0 16 16"
              width="14"
              height="14"
              aria-hidden="true"
            >
              <path
                fill="currentColor"
                d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Zm3.28 5.28-3.75 3.75a.75.75 0 0 1-1.06 0l-1.75-1.75a.75.75 0 1 1 1.06-1.06l1.22 1.22 3.22-3.22a.75.75 0 1 1 1.06 1.06Z"
              />
            </svg>
            <span>
              <Resolution resolution={resolution} resolvedBy={resolvedBy} capitalize />
            </span>
          </div>
        )}
        {candidate && (
          <EvidenceLedger
            confidence={candidate.confidence}
            reasons={candidate.reasons}
            sharedType={candidate.sharedType?.label}
            propertyLabels={data?.propertyLabels}
            distinctStatements={distinctStatements}
            footer={outcome && <EditOutcomePanel outcome={outcome} />}
          >
            {status && status !== "open" ? (
              <>
                <span className="flag flag-status">{status}</span>
                {/* A merged pair's details get the banner above the ledger. */}
                {status !== "merged" && (resolution || resolvedBy) && (
                  <span className="detail-resolution">
                    <Resolution resolution={resolution} resolvedBy={resolvedBy} />
                  </span>
                )}
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
              // Merge / "different from" only make sense on an open pair; once
              // it's dismissed or merged they're hidden.
              <>
                <button
                  type="button"
                  className="btn-dismiss is-quiet"
                  onClick={dismiss}
                  disabled={dismissing || !user}
                  title={user ? undefined : "Log in to dismiss"}
                >
                  {dismissing ? "Dismissing…" : "Dismiss"}
                </button>
                <button
                  type="button"
                  className="btn-different"
                  onClick={() => setDialog("different")}
                  disabled={!user}
                  title={user ? undefined : "Log in to mark as different"}
                >
                  Mark as different
                </button>
                <button
                  type="button"
                  className="btn-merge"
                  onClick={() => setDialog("merge")}
                  disabled={!user}
                  title={user ? undefined : "Log in to merge"}
                >
                  Merge
                </button>
              </>
            )}
          </EvidenceLedger>
        )}
        {data?.snapshot && (
          <p className="detail-note">
            Showing both items as they were when this pair was{" "}
            {candidate?.status === "merged" ? "merged" : "marked as different"}. Wikidata may have
            changed them since.
          </p>
        )}
        {data && candidate && (!data.from || !data.into) && (
          <MissingItemsNote candidate={candidate} from={data.from} into={data.into} />
        )}
      </div>

      {data?.from && data.into && candidate && (
        <MergeCandidates
          from={data.from}
          into={data.into}
          propertyLabels={data.propertyLabels}
          propertyFormatters={data.propertyFormatters}
          propertyMirrors={data.propertyMirrors}
          valueLabels={data.valueLabels}
          creations={creations}
        />
      )}

      {dialog === "merge" && data?.from && data.into && candidate && id && (
        <MergeDialog
          id={id}
          candidate={candidate}
          from={data.from}
          into={data.into}
          detected={detectedConflicts}
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

/**
 * In place of the comparison when one side's data is gone: say which, and why
 * that's expected for a resolved pair, with links to see the items on Wikidata.
 */
function MissingItemsNote({
  candidate,
  from,
  into,
}: {
  candidate: CandidateSummary;
  from: Item | null;
  into: Item | null;
}) {
  const missing = [!from && candidate.fromQid, !into && candidate.intoQid].filter(
    (q): q is string => typeof q === "string",
  );
  return (
    <div className="detail-note is-missing">
      <p>
        {candidate.status === "merged"
          ? "This pair was merged before the app kept a copy of merged items, so there's no comparison to show."
          : candidate.status === "open"
            ? "The mirror doesn't hold data for this pair yet, so there's no comparison to show."
            : "One of these items is no longer in the mirror (merged, deleted, or no longer a matching type), so there's no comparison to show."}{" "}
        Missing: {missing.join(", ")}.
      </p>
      <p>
        See them on Wikidata:{" "}
        {[candidate.fromQid, candidate.intoQid].map((qid, i) => (
          <span key={qid}>
            {i > 0 && " · "}
            <a href={wikiPageUrl(qid)} target="_blank" rel="noreferrer">
              {qid}
            </a>
          </span>
        ))}
      </p>
    </div>
  );
}

type EditOutcome =
  | { kind: "merge"; res: CandidateMergeResponse }
  | { kind: "different"; res: CandidateDifferentResponse };

/** What an edit made from this page did on Wikidata, with links to the revisions. */
function EditOutcomePanel({ outcome }: { outcome: EditOutcome }) {
  if (outcome.kind === "merge") {
    const { from, into, redirected, removedSitelinks } = outcome.res;
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
          ` ${from.qid} was not turned into a redirect; check it on Wikidata and finish it by hand.`}
        <div>
          <strong>
            View merge result:{" "}
            <a href={wikiPageUrl(into.qid)} target="_blank" rel="noreferrer">
              {into.qid}
            </a>
          </strong>
        </div>
        {removedSitelinks?.map((r) => (
          <div key={`${r.qid}:${r.wiki}`}>
            Removed {r.qid}'s {r.wiki} sitelink “{r.title}”, a redirect to “{r.target}”:{" "}
            <a href={r.url} target="_blank" rel="noreferrer">
              revision {r.revid}
            </a>
            .
          </div>
        ))}
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
              `failed: ${e.error}`
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
      {code === "conflict" && " Resolve this on the items on Wikidata by hand, then try again."}
    </p>
  );
}

/**
 * How to fix, by hand on Wikidata, each conflict kind the tool refuses to
 * override. Keyed by the kinds outside AUTO_IGNORED_CONFLICTS.
 */
const BLOCKER_COPY: Record<
  Exclude<MergeConflict, "description">,
  (from: string, into: string) => ReactNode
> = {
  sitelink: (from, into) => (
    <>
      The items have different pages on the same wiki
      <span className="conflict-hint">
        Wikidata refuses to merge two items that each link a different page on one wiki. Remove or
        move the sitelink on {from} or {into} first.
      </span>
    </>
  ),
  statement: (from, into) => (
    <>
      The items link to each other
      <span className="conflict-hint">
        Remove the statements on {from} or {into} whose value is the other item first.
      </span>
    </>
  ),
};

// Confirm-and-merge dialog: names the pair and submits. There are no conflict
// overrides: the server ignores only the auto-handled kinds (a differing
// description) and never tells Wikidata to ignore clashing sitelinks or
// statements. When the mirror predicts one of those, the dialog says so,
// explains the manual fix, and disables the merge button — the tool never
// merges through such a conflict. The server also re-checks the live items
// before merging (the mirror can be stale), so it is the authoritative gate;
// this button gate just keeps the user from attempting a merge that would be
// refused.
function MergeDialog({
  id,
  candidate,
  from,
  into,
  detected,
  onClose,
  onDone,
}: {
  id: string;
  candidate: CandidateSummary;
  from: Item;
  into: Item;
  detected: MergeConflict[];
  onClose: () => void;
  onDone: (res: CandidateMergeResponse) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const autoHandled = detected.filter((k) => AUTO_IGNORED_CONFLICTS.includes(k));
  // Clashes where one page is a redirect to the other item's page (per the
  // nightly replica check) are removed by the server before merging, after it
  // re-checks them against the wiki; if that re-check disagrees, it refuses.
  // Badge-only redirects not yet resolved are asked of the wiki at merge time,
  // where the server removes them if they point at the partner's page and
  // refuses the merge if not.
  const sitelinkPlan = useMemo(() => plannedSitelinkFixes(from, into), [from, into]);
  const sitelinkFixes = sitelinkPlan?.fixes ?? [];
  const pendingChecks = sitelinkPlan?.pending ?? [];
  const blockers = detected.filter(
    (k): k is Exclude<MergeConflict, "description"> =>
      !AUTO_IGNORED_CONFLICTS.includes(k) && !(k === "sitelink" && sitelinkPlan !== null),
  );

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/candidates/:id/merge", { method: "POST", params: { id } });
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
          aliases, sitelinks and statements move to {into.id}. The edit summary credits this tool.
        </p>
        {autoHandled.includes("description") && (
          <p className="modal-note">
            The items have different descriptions; this is handled automatically: {into.id} keeps
            its description and {from.id}'s is dropped.
          </p>
        )}
        {sitelinkFixes.length > 0 && (
          <div className="modal-note">
            {sitelinkFixes.length === 1 ? "A sitelink links" : "These sitelinks link"} a redirect to
            the other item's page, so {sitelinkFixes.length === 1 ? "it is" : "they are"} removed
            first, in a separate edit:
            <ul className="conflict-list">
              {sitelinkFixes.map((f) => (
                <li key={`${f.qid}:${f.wiki}`}>
                  {f.qid}'s {f.wiki} sitelink “{f.title}” → “{f.target}”
                </li>
              ))}
            </ul>
          </div>
        )}
        {pendingChecks.length > 0 && (
          <div className="modal-note">
            {pendingChecks.length === 1 ? "A sitelink is" : "These sitelinks are"} badged as a
            redirect, likely to the other item's page. The merge asks the wiki first: if so,{" "}
            {pendingChecks.length === 1 ? "it is" : "they are"} removed in a separate edit; if not,
            the merge is refused.
            <ul className="conflict-list">
              {pendingChecks.map((p) => (
                <li key={`${p.qid}:${p.wiki}`}>
                  {p.qid}'s {p.wiki} sitelink “{p.title}”, likely → “{p.partnerTitle}”
                </li>
              ))}
            </ul>
          </div>
        )}
        {blockers.length > 0 && (
          <div className="modal-section modal-blockers" role="alert">
            <p className="modal-section-title">This merge is blocked until you fix it by hand</p>
            <ul className="conflict-list">
              {blockers.map((kind) => (
                <li key={kind}>{BLOCKER_COPY[kind](from.id, into.id)}</li>
              ))}
            </ul>
            <p className="conflict-hint">
              Resolve it on{" "}
              <a href={wikiPageUrl(from.id)} target="_blank" rel="noreferrer">
                {from.id}
              </a>{" "}
              or{" "}
              <a href={wikiPageUrl(into.id)} target="_blank" rel="noreferrer">
                {into.id}
              </a>{" "}
              on Wikidata, then merge. This tool never merges through a sitelink or statement
              conflict. Do it by hand.
            </p>
          </div>
        )}
        {error && <EditErrorNote error={error} id={id} />}
      </div>
      <div className="modal-actions">
        <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="btn-primary"
          onClick={submit}
          disabled={busy || blockers.length > 0}
          title={blockers.length > 0 ? "Resolve the conflict on Wikidata first" : undefined}
        >
          {busy ? "Merging…" : "Merge on Wikidata"}
        </button>
      </div>
    </Dialog>
  );
}

// "Criterion used" (P1013) values offered for a "different from" statement:
// the most used ones on Wikidata for P1889 between creative works, people and
// organisations (by a QLever count of existing qualifiers), plus the
// work-vs-series case this tool's pairs often are. Anything else goes in the
// "Other" item-id field.
const CRITERIA: { qid: string; label: string }[] = [
  { qid: "Q55761780", label: "title refers to multiple creative works" },
  { qid: "Q126045708", label: "name of creative work is identical to name of the series" },
  { qid: "Q107214772", label: "same or similar name" },
  { qid: "Q1361758", label: "publication date" },
  { qid: "Q55773103", label: "personal name refers to multiple people" },
  {
    qid: "Q55806838",
    label: "brand, trademark, band name or organization name refers to multiple entities",
  },
];
const OTHER_CRITERION = "other";

// Confirm dialog for "different from": one P1889 statement in each direction,
// optionally qualified with a "criterion used" (P1013), then the candidate is
// dismissed.
function DifferentDialog({
  id,
  candidate,
  onClose,
  onDone,
}: {
  id: string;
  candidate: CandidateSummary;
  onClose: () => void;
  onDone: (res: CandidateDifferentResponse) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  // "" for no qualifier, a preset's QID, or OTHER_CRITERION for the free field.
  const [choice, setChoice] = useState("");
  const [otherQid, setOtherQid] = useState("");

  const other = otherQid.trim().toUpperCase();
  const otherValid = /^Q[1-9]\d*$/.test(other);
  const criterion = choice === OTHER_CRITERION ? (otherValid ? other : null) : choice;

  async function submit() {
    if (criterion === null) return;
    setBusy(true);
    setError(null);
    try {
      const body: CandidateDifferentRequest = criterion ? { criterion } : {};
      const res = await fetch("/api/candidates/:id/different", {
        method: "POST",
        params: { id },
        body,
      });
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
          <b>{side(candidate.intoLabel, candidate.intoQid)}</b>, and the reverse. This candidate is
          then dismissed, and the hunt will not pair these two again.
        </p>
        <div className="modal-section criterion-fields">
          <label className="field">
            <span>
              Criterion used (
              <a
                href="https://www.wikidata.org/wiki/Property:P1013"
                target="_blank"
                rel="noreferrer"
              >
                P1013
              </a>
              ), optional
            </span>
            <select value={choice} onChange={(e) => setChoice(e.target.value)} disabled={busy}>
              <option value="">None</option>
              {CRITERIA.map((c) => (
                <option key={c.qid} value={c.qid}>
                  {c.label} ({c.qid})
                </option>
              ))}
              <option value={OTHER_CRITERION}>Other item…</option>
            </select>
          </label>
          {choice === OTHER_CRITERION && (
            <label className="field">
              <span>Item id</span>
              <input
                className="creator-input"
                type="text"
                value={otherQid}
                onChange={(e) => setOtherQid(e.target.value)}
                placeholder="e.g. Q55761780"
                disabled={busy}
                aria-invalid={(other !== "" && !otherValid) || undefined}
              />
            </label>
          )}
        </div>
        {error && <EditErrorNote error={error} id={id} />}
      </div>
      <div className="modal-actions">
        <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="btn-primary"
          onClick={submit}
          disabled={busy || criterion === null}
          title={criterion === null ? "Enter an item id like Q55761780" : undefined}
        >
          {busy ? "Saving…" : "Add statements"}
        </button>
      </div>
    </Dialog>
  );
}

/**
 * A pair's stored resolution text ("merged into Q2 (rev 123)…") and who
 * resolved it, with the QIDs and the revision linked to Wikidata.
 */
function Resolution({
  resolution,
  resolvedBy,
  capitalize = false,
}: {
  resolution: string | null;
  resolvedBy: string | null;
  capitalize?: boolean;
}) {
  const text =
    resolution && capitalize
      ? resolution.charAt(0).toUpperCase() + resolution.slice(1)
      : resolution;
  return (
    <>
      {text && linkifyResolution(text)}
      {resolvedBy && (
        <>
          {text ? " · by " : "by "}
          <a
            href={wikiPageUrl(`User:${encodeURIComponent(resolvedBy)}`)}
            target="_blank"
            rel="noreferrer"
          >
            {resolvedBy}
          </a>
        </>
      )}
    </>
  );
}

/** Splits resolution text around QIDs and "rev N", linking each to Wikidata. */
function linkifyResolution(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(/\b(Q\d+)\b|\brev (\d+)\b/g)) {
    parts.push(text.slice(last, m.index));
    const [match, qid, revid] = m;
    parts.push(
      <a
        key={m.index}
        href={wikiPageUrl(qid ?? `Special:Diff/${revid}`)}
        target="_blank"
        rel="noreferrer"
      >
        {match}
      </a>,
    );
    last = m.index + match.length;
  }
  parts.push(text.slice(last));
  return parts;
}
