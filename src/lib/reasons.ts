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
