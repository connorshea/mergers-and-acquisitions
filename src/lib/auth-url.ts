// The server login-route URL. Kept out of auth.tsx so that module exports only
// React components/hooks — mixing this plain function in tripped Vite's React
// Fast Refresh ("consistent components exports").

/**
 * The login URL that brings the user back to `returnTo` (a same-site path).
 * Any `?auth=` outcome flag from an earlier failed login is stripped so a
 * successful retry doesn't land on a stale "Login cancelled" alert.
 */
export function loginUrl(returnTo: string): string {
  const qIndex = returnTo.indexOf("?");
  if (qIndex !== -1) {
    const query = new URLSearchParams(returnTo.slice(qIndex + 1));
    query.delete("auth");
    const rest = query.toString();
    returnTo = returnTo.slice(0, qIndex) + (rest ? `?${rest}` : "");
  }
  return `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
}
