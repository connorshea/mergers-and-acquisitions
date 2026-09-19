// Client-side view of the login session: who is logged in (from
// /api/auth/me), whether login is even configured on this server, and a logout
// action. Tokens never reach the client; this only knows the user's name/id.
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { fetch } from "./client.ts";
import { setWikiBaseUrl } from "./wiki.ts";
import { type AuthState, AuthContext } from "./auth-context.ts";
import type { AuthMeResponse } from "./api-types.ts";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Pick<AuthState, "user" | "configured" | "loading">>({
    user: null,
    configured: false,
    loading: true,
  });

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/me")
      .then((res) => {
        if (cancelled) return;
        const me = res as AuthMeResponse;
        // The wiki instance is app-wide config, not per-render state: stash it in
        // the shared holder so links can be built without prop drilling.
        setWikiBaseUrl(me.wikiBaseUrl);
        setState({ user: me.user, configured: me.configured, loading: false });
      })
      .catch(() => {
        if (!cancelled) setState((s) => ({ ...s, loading: false }));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const logout = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    setState((s) => ({ ...s, user: null }));
  }, []);

  return <AuthContext value={{ ...state, logout }}>{children}</AuthContext>;
}
