// Client-side view of the login session: who is logged in (from
// /api/auth/me), whether login is even configured on this server, and a logout
// action. Tokens never reach the client; this only knows the user's name/id.
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { fetch } from "./client.ts";
import type { AuthMeResponse, AuthUserInfo } from "./api-types.ts";

export interface AuthState {
  user: AuthUserInfo | null;
  /** False when the server has no OAuth consumer configured. */
  configured: boolean;
  /** True until the first /api/auth/me response lands. */
  loading: boolean;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState>({
  user: null,
  configured: false,
  loading: true,
  logout: async () => {},
});

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

export function useAuth(): AuthState {
  return useContext(AuthContext);
}

/** The login URL that brings the user back to `returnTo` (a same-site path). */
export function loginUrl(returnTo: string): string {
  return `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
}
