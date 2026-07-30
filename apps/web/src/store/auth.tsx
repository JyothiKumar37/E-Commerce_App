import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, setAccessToken, setAuthLostHandler } from "@/lib/api";
import type { User } from "@/lib/types";

interface AuthResponse {
  accessToken: string;
  expiresIn: string;
  user: User;
}

interface AuthContextValue {
  user: User | null;
  /** True until the initial silent-refresh attempt settles. */
  initialising: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (input: SignUpInput) => Promise<void>;
  signOut: () => Promise<void>;
  isAdmin: boolean;
}

export interface SignUpInput {
  username: string;
  email: string;
  password: string;
  first_name: string;
  last_name: string;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** Parses "15m" / "900s" / "1h" into milliseconds. */
function ttlToMs(ttl: string): number {
  const match = /^(\d+)([smhd])$/.exec(ttl.trim());
  if (!match) return 15 * 60_000;
  const value = Number(match[1]);
  const multiplier =
    { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as string] ?? 60_000;
  return value * multiplier;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [initialising, setInitialising] = useState(true);
  const refreshTimer = useRef<number | null>(null);
  const queryClient = useQueryClient();

  const clearSession = useCallback(() => {
    setAccessToken(null);
    setUser(null);
    if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
    refreshTimer.current = null;
    // Drop every cached query: the next user must not see the last one's data.
    queryClient.clear();
  }, [queryClient]);

  /**
   * Re-refreshes shortly before the access token expires, so a user who is
   * reading a page for twenty minutes never sees a flash of 401.
   */
  const scheduleRefresh = useCallback((expiresIn: string) => {
    if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
    const lead = 60_000; // refresh a minute early
    const delay = Math.max(ttlToMs(expiresIn) - lead, 30_000);

    refreshTimer.current = window.setTimeout(async () => {
      const token = await api.refresh();
      if (token) scheduleRefresh(expiresIn);
    }, delay);
  }, []);

  const applySession = useCallback(
    (response: AuthResponse) => {
      setAccessToken(response.accessToken);
      setUser(response.user);
      scheduleRefresh(response.expiresIn);
    },
    [scheduleRefresh],
  );

  // On mount, try to resume the session from the refresh cookie. This is what
  // makes a page reload keep the user signed in without storing a token in
  // localStorage.
  useEffect(() => {
    let cancelled = false;

    setAuthLostHandler(() => clearSession());

    (async () => {
      try {
        const response = await api.post<AuthResponse>("/auth/refresh", undefined, {
          skipRefresh: true,
        });
        if (!cancelled) applySession(response);
      } catch {
        if (!cancelled) setAccessToken(null);
      } finally {
        if (!cancelled) setInitialising(false);
      }
    })();

    return () => {
      cancelled = true;
      setAuthLostHandler(null);
      if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
    };
  }, [applySession, clearSession]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      const response = await api.post<AuthResponse>(
        "/auth/signin",
        { email, password },
        { skipRefresh: true },
      );
      applySession(response);
      await queryClient.invalidateQueries();
    },
    [applySession, queryClient],
  );

  const signUp = useCallback(
    async (input: SignUpInput) => {
      const response = await api.post<AuthResponse>("/auth/signup", input, { skipRefresh: true });
      applySession(response);
      await queryClient.invalidateQueries();
    },
    [applySession, queryClient],
  );

  const signOut = useCallback(async () => {
    try {
      await api.post("/auth/signout", undefined, { skipRefresh: true });
    } catch {
      // Even if the server call fails, the local session must end.
    }
    clearSession();
  }, [clearSession]);

  const value = useMemo<AuthContextValue>(
    () => ({ user, initialising, signIn, signUp, signOut, isAdmin: user?.role === "admin" }),
    [user, initialising, signIn, signUp, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside an <AuthProvider>");
  return context;
}
