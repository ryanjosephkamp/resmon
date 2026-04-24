import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import {
  getAccessToken,
  setAccessToken,
  registerRefresh,
  onSignOut,
} from '../api/authStore';

/**
 * Auth context for the resmon-cloud account (IMPL-30).
 *
 * Access tokens are held only in the module-scoped `authStore` — never in
 * React state, never in `localStorage`, never on disk. Refresh tokens live
 * in the OS keychain, managed by Electron-main via the Python `keyring`
 * bridge (`service=resmon`, `account=cloud_refresh_token`). See §§8.2–8.3
 * of `resmon_routines_and_accounts.md`.
 */

export interface AuthState {
  isSignedIn: boolean;
  email: string;
  accessToken: string | null;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  refreshAccessToken: () => Promise<string | null>;
}

const AuthContext = createContext<AuthState | null>(null);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [isSignedIn, setIsSignedIn] = useState(false);
  const [email, setEmail] = useState('');

  const refreshStatus = useCallback(async () => {
    try {
      const s = await window.resmonAPI?.cloudAuth?.status();
      if (s) {
        setIsSignedIn(!!s.signed_in);
        setEmail(s.email || '');
      }
    } catch { /* ignore */ }
  }, []);

  const signIn = useCallback(async () => {
    const bridge = window.resmonAPI?.cloudAuth;
    if (!bridge) throw new Error('Cloud account bridge unavailable');
    const out = await bridge.signIn();
    setAccessToken(out.access_token);
    setIsSignedIn(true);
    setEmail(out.email || '');
  }, []);

  const signOut = useCallback(async () => {
    const bridge = window.resmonAPI?.cloudAuth;
    if (bridge) {
      try { await bridge.signOut(); } catch { /* ignore */ }
    }
    setAccessToken(null);
    setIsSignedIn(false);
    setEmail('');
  }, []);

  const refreshAccessToken = useCallback(async (): Promise<string | null> => {
    const bridge = window.resmonAPI?.cloudAuth;
    if (!bridge) return null;
    try {
      const out = await bridge.refresh();
      setAccessToken(out.access_token);
      return out.access_token;
    } catch {
      setAccessToken(null);
      setIsSignedIn(false);
      setEmail('');
      return null;
    }
  }, []);

  useEffect(() => {
    registerRefresh(refreshAccessToken);
    refreshStatus();
    const unsub = onSignOut(() => {
      setAccessToken(null);
      setIsSignedIn(false);
      setEmail('');
    });
    return () => { unsub(); };
  }, [refreshAccessToken, refreshStatus]);

  return (
    <AuthContext.Provider
      value={{
        isSignedIn,
        email,
        accessToken: getAccessToken(),
        signIn,
        signOut,
        refreshAccessToken,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
