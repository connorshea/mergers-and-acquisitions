// The login/logout control shown in each page's header. Login is a plain link
// to the server's OAuth start route (a full-page navigation, not a fetch), so
// the redirect to meta.wikimedia.org and back works without any client state.
import { useState } from "react";
import { useLocation } from "react-router-dom";
import { useAuth } from "./lib/auth-context.ts";
import { loginUrl } from "./lib/auth-url.ts";
import { wikiPageUrl } from "./lib/wiki.ts";

export default function AuthBar() {
  const { user, configured, loading, logout } = useAuth();
  const location = useLocation();
  const [busy, setBusy] = useState(false);

  if (loading) return null;

  if (user) {
    // Link the name to the user's page on the same wiki the app edits (e.g.
    // test.wikidata.org while developing), not always www.wikidata.org.
    const userPageUrl = wikiPageUrl(`User:${encodeURIComponent(user.username)}`);
    return (
      <div className="auth-bar">
        <span className="auth-user" title={`Wikimedia user id ${user.id}`}>
          <a href={userPageUrl} target="_blank" rel="noreferrer" className="auth-user-link">
            {user.username}
          </a>
          {user.isAdmin && <span className="auth-badge">admin</span>}
          {user.blocked && (
            <span className="auth-badge is-blocked" title="This account is blocked on Wikidata">
              blocked
            </span>
          )}
        </span>
        <button
          type="button"
          className="btn-secondary"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void logout().finally(() => setBusy(false));
          }}
        >
          {busy ? "Logging out…" : "Log out"}
        </button>
      </div>
    );
  }

  if (!configured) {
    return (
      <span className="auth-note" title="Set OAUTH_CLIENT_ID etc. on the server to enable login">
        Login not configured
      </span>
    );
  }

  return (
    <a className="btn-secondary auth-login" href={loginUrl(location.pathname + location.search)}>
      Log in with Wikimedia
    </a>
  );
}
