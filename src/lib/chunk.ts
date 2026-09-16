// Split an array into fixed-size chunks. DOM-free so server routes, queues, and
// crons can all use it — chiefly to keep D1 queries under its bound-parameter
// cap (see D1_MAX_BOUND_PARAMS): an `inArray(col, ids)` with more than ~100 ids
// throws "too many SQL variables", so callers chunk the ids and union results.

/**
 * D1 caps bound parameters at 100 per statement (below SQLite's own limit). Any
 * query whose parameter count scales with input length — `inArray`, multi-row
 * insert — must stay under this.
 */
export const D1_MAX_BOUND_PARAMS = 100;

/** Split `items` into consecutive chunks of at most `size` (size >= 1). */
export function chunk<T>(items: T[], size: number): T[][] {
  if (size < 1) throw new Error(`chunk size must be >= 1, got ${size}`);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
