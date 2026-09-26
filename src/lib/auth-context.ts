// The auth context, its shape, and the `useAuth` hook. Kept out of auth.tsx so
// that module exports only React components — mixing the context/hook in trips
// Vite's React Fast Refresh ("Fast refresh only works when a file only exports
// components"). See also auth-url.ts.
import { createContext, useContext } from "react";
import type { AuthUserInfo } from "./api-types.ts";

export interface AuthState {
  user: AuthUserInfo | null;
  /** False when the server has no OAuth consumer configured. */
  configured: boolean;
  /** True until the first /api/auth/me response lands. */
  loading: boolean;
  logout: () => Promise<void>;
  /** Save the user's reader languages (PUT /api/settings) and update `user`. */
  saveLanguages: (languages: string[]) => Promise<void>;
}

export const AuthContext = createContext<AuthState>({
  user: null,
  configured: false,
  loading: true,
  logout: async () => {},
  saveLanguages: async () => {},
});

export function useAuth(): AuthState {
  return useContext(AuthContext);
}
