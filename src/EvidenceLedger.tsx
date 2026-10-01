import type { ReactNode } from "react";
import { confidenceVerdict, groupReasons, reasonPids, type ReasonTone } from "./lib/reasons.ts";
import ReasonText from "./ReasonText.tsx";

// The candidate detail page's summary card: the confidence score read out in
// words with a meter, the page's actions (passed in as children), and below
// them the scorer's reasons as a two-column ledger of signals for and against
// the pair being one item. Reasons that name properties link to those rows in
// the comparison table below (MergeCandidates gives each statement row an id).
export default function EvidenceLedger({
  confidence,
  reasons,
  sharedType,
  propertyLabels,
  distinctStatements = 0,
  children,
  footer,
}: {
  confidence: number;
  reasons: string[];
  /** The class both items are an instance of, named in the P31 signal. */
  sharedType?: string | null;
  propertyLabels?: Record<string, string>;
  /**
   * Statements that differ between the items, not counting non-evidence ids
   * (countDistinctStatements). Mentioned when no signal counts against the pair.
   */
  distinctStatements?: number;
  /** The actions, at the right of the header. */
  children: ReactNode;
  /** Shown under the header, e.g. the result of an edit made from the page. */
  footer?: ReactNode;
}) {
  const { positive, negative, notes, heldBelow } = groupReasons(reasons);
  // "same instance of (P31)" names the property but not what it holds.
  const display = (text: string) =>
    sharedType && text === "same instance of (P31)" ? `same instance of: ${sharedType}` : text;
  const pct = Math.round(confidence * 100);
  const tier = confidence >= 0.6 ? "identical" : confidence >= 0.4 ? "similar" : "distinct";

  return (
    <section className="evidence" aria-label="Score">
      <div className="evidence-head">
        <div className="evidence-score">
          <span className={`evidence-pct tone-${tier}`}>{pct}%</span>
          <span className="evidence-score-label">confidence</span>
        </div>
        <div className="evidence-verdict">
          <div className="evidence-verdict-text">
            <strong>{confidenceVerdict(confidence)}</strong>
            {heldBelow && (
              <span className="evidence-held">
                Held below near-certain: {heldBelow.replace(/\.$/, "")}.
              </span>
            )}
          </div>
          <div
            className={`evidence-meter tone-${tier}`}
            role="meter"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
            aria-label="Confidence"
          >
            <span style={{ width: `${pct}%` }} />
          </div>
        </div>
        <div className="detail-actions">{children}</div>
      </div>
      {footer}
      <div className="evidence-body">
        <SignalColumn
          polarity="positive"
          title="Same item"
          empty="Nothing points to these being the same item."
          signals={positive}
          display={display}
          propertyLabels={propertyLabels}
        />
        <SignalColumn
          polarity="negative"
          title="Different items"
          empty={
            distinctStatements > 0
              ? `No strong signal, but ${distinctStatements} ${
                  distinctStatements === 1 ? "statement differs" : "statements differ"
                } between the items.`
              : "Nothing strongly points to these being different items."
          }
          signals={negative}
          display={display}
          propertyLabels={propertyLabels}
        />
      </div>
      {notes.length > 0 && (
        <ul className="evidence-notes">
          {notes.map((n) => (
            <li key={n}>
              <ReasonText text={n} propertyLabels={propertyLabels} inline maxIds={3} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SignalColumn({
  polarity,
  title,
  empty,
  signals,
  display,
  propertyLabels,
}: {
  polarity: "positive" | "negative";
  title: string;
  empty: string;
  signals: { text: string; tone: ReasonTone }[];
  display: (text: string) => string;
  propertyLabels?: Record<string, string>;
}) {
  return (
    <div className={`evidence-col is-${polarity}`}>
      <h2 className="evidence-col-title">
        {title} · {signals.length} {signals.length === 1 ? "signal" : "signals"}
      </h2>
      {signals.length === 0 ? (
        <p className="evidence-empty">{empty}</p>
      ) : (
        <ul className="evidence-list">
          {signals.map(({ text, tone }) => (
            <Signal
              key={text}
              polarity={polarity}
              text={text}
              display={display(text)}
              tone={tone}
              propertyLabels={propertyLabels}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

const MAX_PID_LINKS = 2;

function Signal({
  polarity,
  text,
  display,
  tone,
  propertyLabels,
}: {
  polarity: "positive" | "negative";
  text: string;
  /** What to show for `text`; its property ids still come from `text`. */
  display: string;
  tone: ReasonTone;
  propertyLabels?: Record<string, string>;
}) {
  const pids = reasonPids(text);
  const shown = pids.slice(0, MAX_PID_LINKS);
  const strength =
    tone.strength === 3
      ? "Strong"
      : tone.strength === 2
        ? "Moderate"
        : polarity === "positive"
          ? "Supporting"
          : "Minor";
  return (
    <li className={`evidence-signal strength-${tone.strength}`}>
      <SignalIcon polarity={polarity} filled={tone.strength === 3} />
      <span className="evidence-signal-text">
        <ReasonText text={display} propertyLabels={propertyLabels} inline maxIds={3} />
      </span>
      <span className="evidence-signal-meta">
        {shown.map((pid) => (
          <a
            key={pid}
            className="evidence-pid"
            href={`#row-${pid}`}
            title={`Show ${propertyLabels?.[pid] ?? pid} in the comparison below`}
            onClick={(e) => {
              // Scroll without touching the URL; a row in a hidden group
              // isn't in the DOM, so fall back to the plain anchor. Focus
              // follows, so the next Tab continues from the row and a screen
              // reader reads it out.
              const row = document.getElementById(`row-${pid}`);
              if (!row) return;
              e.preventDefault();
              const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
              row.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "center" });
              row.focus({ preventScroll: true });
              flashRow(row);
            }}
          >
            {pid}
          </a>
        ))}
        {pids.length > shown.length && (
          <span className="evidence-pid-more">+{pids.length - shown.length}</span>
        )}
        <span className="evidence-strength">{strength}</span>
      </span>
    </li>
  );
}

/**
 * Briefly tint a comparison row so the eye lands on it after the scroll.
 * Re-adding the class restarts the animation on a repeat click.
 */
function flashRow(row: HTMLElement) {
  row.classList.remove("is-flashing");
  void row.offsetWidth; // force a reflow so the animation starts over
  row.classList.add("is-flashing");
  row.addEventListener("animationend", () => row.classList.remove("is-flashing"), { once: true });
}

function SignalIcon({ polarity, filled }: { polarity: "positive" | "negative"; filled: boolean }) {
  return (
    <svg
      className={`evidence-icon${filled ? " is-filled" : ""}`}
      viewBox="0 0 20 20"
      width="20"
      height="20"
      aria-hidden="true"
    >
      <circle cx="10" cy="10" r="9" />
      <path
        d={
          polarity === "negative" ? "M6 10h8" : filled ? "M6 10.2l2.7 2.7L14 7.6" : "M10 6v8M6 10h8"
        }
      />
    </svg>
  );
}
