// Remembers the candidate list's query string (filters, sort, page) for this
// tab so "Back to candidates" returns to the same view instead of the bare
// default list. Storage can be unavailable (private mode, blocked site data),
// so every access is best-effort and falls back to the default list.

const KEY = "mc:list-search";

export function rememberListSearch(search: string): void {
  try {
    if (search) sessionStorage.setItem(KEY, search);
    else sessionStorage.removeItem(KEY);
  } catch {
    // Ignore: the back link just falls back to the default list.
  }
}

/** The list URL, carrying the last-used filters when there are any. */
export function listHref(): string {
  try {
    const search = sessionStorage.getItem(KEY);
    if (search) return `/?${search}`;
  } catch {
    // Fall through to the default list.
  }
  return "/";
}
