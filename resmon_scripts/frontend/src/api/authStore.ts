/**
 * Module-scoped singleton for the current cloud access token (IMPL-30).
 *
 * The access token lives only in renderer memory. cloudClient.ts and
 * AuthContext.tsx share this store so that Bearer-token injection and
 * refresh-on-401 do not require threading the token through prop trees.
 */

let accessToken: string | null = null;
const changeListeners = new Set<(t: string | null) => void>();

export function setAccessToken(token: string | null): void {
  accessToken = token;
  changeListeners.forEach((cb) => { try { cb(token); } catch { /* ignore */ } });
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function onAccessTokenChange(cb: (t: string | null) => void): () => void {
  changeListeners.add(cb);
  return () => changeListeners.delete(cb);
}

// The refresh function is registered by AuthContext on mount so that
// cloudClient.ts can trigger a transparent refresh without importing React.
let refreshImpl: () => Promise<string | null> = async () => null;

export function registerRefresh(fn: () => Promise<string | null>): void {
  refreshImpl = fn;
}

export function triggerRefresh(): Promise<string | null> {
  return refreshImpl();
}

// "Signed out" listeners — cloudClient invokes this after a second
// consecutive 401, so the UI can clear auth state and prompt re-sign-in.
const signOutListeners = new Set<() => void>();

export function onSignOut(cb: () => void): () => void {
  signOutListeners.add(cb);
  return () => signOutListeners.delete(cb);
}

export function emitSignOut(): void {
  signOutListeners.forEach((cb) => { try { cb(); } catch { /* ignore */ } });
}
