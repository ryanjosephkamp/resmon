/**
 * cloudClient — JWT-aware HTTP wrapper for the resmon-cloud service (IMPL-30).
 *
 * Behavior per §8.3 of `resmon_routines_and_accounts.md`:
 * - Every request attaches `Authorization: Bearer <access>` if an access
 *   token is in memory.
 * - On a 401 response, cloudClient calls `triggerRefresh()` (wired to the
 *   Electron-main IdP refresh flow through `authStore`) exactly once and
 *   retries the original request with the new access token.
 * - If a second consecutive 401 is received, cloudClient emits `onSignOut`
 *   through `authStore`, which clears in-memory auth state so the UI can
 *   prompt the user to sign in again.
 *
 * The base URL points at the cloud service. For local development against
 * the dev-compose container (`docker-compose.dev.yml`), set
 * `RESMON_CLOUD_BASE_URL` to e.g. `http://localhost:8080`. In production
 * it is baked in at build time via `window.resmonCloudBaseUrl`.
 */

import {
  emitSignOut,
  getAccessToken,
  triggerRefresh,
} from './authStore';

export function getCloudBaseUrl(): string {
  const fromWindow = (window as any).resmonCloudBaseUrl as string | undefined;
  if (fromWindow) return fromWindow;
  return 'https://cloud.resmon.invalid';
}

interface CloudRequestInit extends RequestInit {
  /** Skip the auto-refresh retry (used internally after a retry). */
  _retried?: boolean;
}

async function doFetch<T>(
  method: string,
  path: string,
  body: unknown,
  init: CloudRequestInit = {},
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string> | undefined),
  };
  const token = getAccessToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${getCloudBaseUrl()}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (res.status === 401) {
    if (init._retried) {
      // Second consecutive 401 — give up and tell the UI to sign out.
      emitSignOut();
      const text = await safeText(res);
      throw new CloudUnauthorizedError(text || 'Cloud session expired');
    }
    // First 401 — try a transparent refresh exactly once.
    const fresh = await triggerRefresh();
    if (!fresh) {
      emitSignOut();
      const text = await safeText(res);
      throw new CloudUnauthorizedError(text || 'Cloud session expired');
    }
    return doFetch<T>(method, path, body, { ...init, _retried: true });
  }

  if (!res.ok) {
    const text = await safeText(res);
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }

  // Empty-body tolerant JSON parse.
  const text = await res.text();
  if (!text) return undefined as unknown as T;
  return JSON.parse(text) as T;
}

async function safeText(res: Response): Promise<string> {
  try { return await res.text(); } catch { return ''; }
}

export class CloudUnauthorizedError extends Error {
  constructor(msg: string) { super(msg); this.name = 'CloudUnauthorizedError'; }
}

export const cloudClient = {
  get:    <T = any>(path: string)                 => doFetch<T>('GET',    path, undefined),
  post:   <T = any>(path: string, body?: unknown) => doFetch<T>('POST',   path, body),
  put:    <T = any>(path: string, body?: unknown) => doFetch<T>('PUT',    path, body),
  delete: <T = any>(path: string)                 => doFetch<T>('DELETE', path, undefined),
};
