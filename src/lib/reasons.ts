// Helpers for displaying the scorer's reason strings (see scoreCandidate in
// compare.ts).

/** Reasons that list every shared identifier property, comma-separated. */
const ID_LIST_REASON = /^(shares (?:external|account\/social) identifier): (.+)$/;

/**
 * Split an identifier-list reason ("shares external identifier: P1733, P2725,
 * …") into its prefix, the first `max` ids, and the rest, so a compact view can
 * show "…: A, B, C, and 4 others". Null for any other reason, or one listing no
 * more than `max` ids.
 */
export function capIdReason(
  text: string,
  max: number,
): { prefix: string; shown: string[]; hidden: string[] } | null {
  const m = ID_LIST_REASON.exec(text);
  if (!m) return null;
  const ids = m[2].split(", ");
  if (ids.length <= max) return null;
  return { prefix: m[1], shown: ids.slice(0, max), hidden: ids.slice(max) };
}

/** Which way a reason pushes the score, and roughly how hard (1 weak – 3 strong). */
export interface ReasonTone {
  polarity: "positive" | "negative" | "neutral";
  strength: 1 | 2 | 3;
}

// Reason patterns, first match wins, with the tone of the score change behind
// each (see scoreCandidate): strength 3 is a ≥0.35 swing or a hard cap, 2 is
// ≈0.15–0.3, 1 is ≤0.1 (or informational). Order matters where one reason's
// text is a prefix of another's ("different names in native script" before
// "different names").
const REASON_TONES: [RegExp, ReasonTone["polarity"], ReasonTone["strength"]][] = [
  // Disqualifiers and hard caps.
  [
    /not a duplicate|not a merge target|can't be merged|separate objects|almost certainly different/,
    "negative",
    3,
  ],
  [/^different instance of/, "negative", 3],
  // Doesn't move the score by itself, but the merge can't go through as-is.
  [/would block the merge$/, "negative", 3],
  [/^different names in native script/, "negative", 2],
  [/^different names \(/, "negative", 3],
  [/^different social-media accounts/, "negative", 2],
  [/^publication\/inception\/birth years differ/, "negative", 2],
  [/^one item references the other/, "negative", 2],
  [/^different /, "negative", 2], // developer, publisher, author, …
  [/^a per-subject identifier differs/, "negative", 1],
  [/not counted/, "neutral", 1],
  [/^shares external identifier/, "positive", 3],
  [/^identical label|^label matches the other item's alias/, "positive", 3],
  [/^very similar names/, "positive", 2],
  [/^same date of (birth|death)/, "positive", 2],
  [/^sitelink redirects to the other item's page/, "positive", 2],
  [/^shares /, "positive", 1], // account/social, aggregator, page-section ids
  [/^loosely similar names/, "positive", 1],
  [/^same instance of/, "positive", 1],
  [/^Wikipedia articles in different languages/, "positive", 1],
  [/^identical description|^similar descriptions/, "positive", 1],
];

/**
 * Classify a scorer reason as a positive or negative signal and how strong it
 * is, for coloring it. "N of M shared statements agree" (worth at most 0.2)
 * is medium when at least half agree, weak otherwise. Unknown reasons are
 * neutral.
 */
export function reasonTone(text: string): ReasonTone {
  const agree = /^(\d+) of (\d+) shared statements agree$/.exec(text);
  if (agree) {
    const ratio = Number(agree[1]) / Number(agree[2]);
    return { polarity: "positive", strength: ratio >= 0.5 ? 2 : 1 };
  }
  for (const [re, polarity, strength] of REASON_TONES) {
    if (re.test(text)) return { polarity, strength };
  }
  return { polarity: "neutral", strength: 1 };
}

/** A one-line reading of a confidence score, for the detail page's header. */
export function confidenceVerdict(confidence: number): string {
  if (confidence >= 0.9) return "Almost certainly the same item";
  if (confidence >= 0.6) return "Likely the same item";
  if (confidence >= 0.4) return "Possibly the same item";
  return "Probably different items";
}

// Older hunts wrote "held below near-certain — …"; current ones use a colon.
const HELD_BELOW = /^held below near-certain(?::| —) (.+)$/;

/**
 * Sort a candidate's reasons for the evidence ledger: signals for and against
 * the pair being one item, the rest (ids not counted, unknown reasons) as
 * notes, and the scorer's "held below near-certain" explanation pulled out on
 * its own (just the why, e.g. "the names only loosely match").
 */
export function groupReasons(reasons: string[]): {
  positive: { text: string; tone: ReasonTone }[];
  negative: { text: string; tone: ReasonTone }[];
  notes: string[];
  heldBelow: string | null;
} {
  const positive: { text: string; tone: ReasonTone }[] = [];
  const negative: { text: string; tone: ReasonTone }[] = [];
  const notes: string[] = [];
  let heldBelow: string | null = null;
  for (const text of reasons) {
    const held = HELD_BELOW.exec(text);
    if (held) {
      heldBelow = held[1];
      continue;
    }
    const tone = reasonTone(text);
    if (tone.polarity === "neutral") notes.push(text);
    else (tone.polarity === "positive" ? positive : negative).push({ text, tone });
  }
  // Strongest first; Array.sort is stable, so the scorer's order holds within
  // a strength.
  const byStrength = (x: { tone: ReasonTone }, y: { tone: ReasonTone }) =>
    y.tone.strength - x.tone.strength;
  positive.sort(byStrength);
  negative.sort(byStrength);
  return { positive, negative, notes, heldBelow };
}

/** The property ids a reason names, in order, without repeats. */
export function reasonPids(text: string): string[] {
  return [...new Set(text.match(/\bP\d+\b/g) ?? [])];
}
