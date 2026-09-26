// The login/logout control shown in each page's header. Login is a plain link
// to the server's OAuth start route (a full-page navigation, not a fetch), so
// the redirect to www.wikidata.org and back works without any client state.
import { useState } from "react";
import { useLocation } from "react-router-dom";
import { useAuth } from "./lib/auth-context.ts";
import { loginUrl } from "./lib/auth-url.ts";
import { wikiPageUrl } from "./lib/wiki.ts";
import Dialog from "./Dialog.tsx";

// On phones the Log out button sits right under the header where it's easy to
// hit by accident, so there it asks first. Same breakpoint as the mobile layout.
const CONFIRM_LOGOUT_QUERY = "(max-width: 640px)";

export default function AuthBar() {
  const { user, configured, loading, logout } = useAuth();
  const location = useLocation();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  if (loading) return null;

  if (user) {
    // Link the name to the user's page on the same wiki the app edits (e.g.
    // test.wikidata.org while developing), not always www.wikidata.org.
    const userPageUrl = wikiPageUrl(`User:${encodeURIComponent(user.username)}`);
    const doLogout = () => {
      setConfirming(false);
      setBusy(true);
      void logout().finally(() => setBusy(false));
    };
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
            if (window.matchMedia(CONFIRM_LOGOUT_QUERY).matches) setConfirming(true);
            else doLogout();
          }}
        >
          {busy ? "Logging out…" : "Log out"}
        </button>
        {confirming && (
          <Dialog title="Log out?" onClose={() => setConfirming(false)}>
            <p className="modal-body">You’ll need to log in with Wikimedia again to make edits.</p>
            <div className="modal-actions">
              <button type="button" className="btn-secondary" onClick={() => setConfirming(false)}>
                Cancel
              </button>
              <button type="button" className="btn-primary" onClick={doLogout}>
                Log out
              </button>
            </div>
          </Dialog>
        )}
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
