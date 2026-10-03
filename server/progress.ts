// Formatting shared by the scheduled jobs' progress lines.

/** "done/total (pct%)", with `done` capped at `total` (the last page or chunk is short). */
export function progress(done: number, total: number): string {
  const n = Math.min(done, total);
  return `${n}/${total} (${total > 0 ? ((n / total) * 100).toFixed(1) : "100.0"}%)`;
}

/** Whole seconds since `since` (a `Date.now()` reading), e.g. "42s". */
export const elapsed = (since: number): string => `${Math.round((Date.now() - since) / 1000)}s`;
