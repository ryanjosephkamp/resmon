export interface DownloadRecord {
  id: string; filename: string; state: 'progressing' | 'completed' | 'cancelled' | 'interrupted';
  path: string; receivedBytes: number; totalBytes: number;
}

declare global {
  interface Window {
    resmonAPI?: {
      getBackendPort: () => string;
      getApiToken?: () => string | null;
      getDownloads?: () => Promise<DownloadRecord[]>;
      revealDownload?: (id: string) => Promise<boolean>;
      onDownloadsChanged?: (callback: (records: DownloadRecord[]) => void) => (() => void);
      platform: string;
      versions: { node: string; electron: string };
      chooseDirectory?: (defaultPath?: string) => Promise<string | null>;
      chooseFile?: (defaultPath?: string) => Promise<string | null>;
      openPath?: (targetPath: string) => Promise<string>;
      revealPath?: (targetPath: string) => Promise<boolean>;
    };
  }
}

/**
 * The backend this window belongs to, or a refusal.
 *
 * This used to end `|| '8742'`, so any falsy answer from the preload — no
 * bridge at all, an empty string, a zero — addressed every request in the app
 * at port 8742. That is the port the background daemon binds, which on a
 * machine running both is a *different* resmon over a different database,
 * while this app's own backend sits on an ephemeral port chosen at launch.
 * Nothing on screen would have said the instance had changed.
 *
 * The same shape, written in the MCP server, once attached a harness to the
 * daemon when a named port stopped answering, and every tool then answered
 * truthfully about the wrong corpus. Its port resolution reports the instance
 * as unavailable instead, and this is the renderer's version of that: an
 * absent port is an error state, not a value to invent.
 *
 * **8742 itself is not refused here.** Electron attaches to a running daemon
 * when it finds one, and then 8742 is the truthful answer and the renderer must
 * use it. The defect was guessing, not the number. (The Evidence and selected
 * answer lanes *do* refuse it, because the backend refuses to serve those lanes
 * from a default-port instance at all — a narrower rule, in their own code.)
 *
 * Throwing, rather than returning null, is what keeps this in the error channel
 * the app already has: every call site is inside an async function, so the
 * throw becomes the same rejected promise a refused connection produces today,
 * and `useConnectionIdentity` already turns that into the header's "Running app
 * unavailable". A nullable return would need a new branch at every call site,
 * and a missed one would address `http://127.0.0.1:null` — a fresh silent
 * failure in place of the one being removed.
 */
export function getBaseUrl(): string {
  const port = window.resmonAPI?.getBackendPort();
  // A string, because that is what the preload exposes; a bare decimal with no
  // leading zero, sign or space, because `Number(' 80 ')` is 80 and a port that
  // needed trimming did not come from the main process.
  if (typeof port !== 'string' || !/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65535) {
    throw new Error(
      'resmon cannot reach its backend: this window was not told which local port '
      + 'the backend is listening on. Quit and reopen resmon; if that does not help, '
      + 'the backend did not start.',
    );
  }
  return `http://127.0.0.1:${port}`;
}

/**
 * The header every request to the backend carries (2.2 lock-down).
 *
 * The backend refuses anything without its token, so a call site that builds
 * its own `fetch` must spread this in — or, better, use `backendFetch`. The
 * token only ever travels in this header: never in a URL, where it would land
 * in history, logs and `Referer`. That is why a plain `<a href>` to the API no
 * longer works and downloads fetch to a blob instead.
 */
export function authHeaders(): Record<string, string> {
  const token = window.resmonAPI?.getApiToken?.();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * `fetch` against the backend: `path` is appended to `getBaseUrl()`, the token is added.
 *
 * `async` so that a caller which does not `await` — a `.then()` chain — sees a
 * rejected promise rather than a synchronous throw when `getBaseUrl()` refuses.
 * Every caller today awaits it, for which the two are identical; this costs
 * nothing and removes the difference.
 */
export async function backendFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(authHeaders())) headers.set(name, value);
  return fetch(`${getBaseUrl()}${path}`, { ...init, headers });
}

async function request<T = any>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const opts: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      Pragma: 'no-cache',
      ...authHeaders(),
    },
    cache: 'no-store',
  };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${getBaseUrl()}${path}`, opts);
  if (!res.ok) {
    const text = await res.text();
    // FastAPI returns { detail: "..." } for HTTPException — surface that
    // human-readable message when present instead of the raw JSON blob.
    let detail = text;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed.detail === 'string') detail = parsed.detail;
    } catch { /* non-JSON body, keep raw text */ }
    throw new Error(`${res.status} ${res.statusText}: ${detail}`);
  }
  return res.json();
}

export const apiClient = {
  get: <T = any>(path: string) => request<T>('GET', path),
  post: <T = any>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T = any>(path: string, body?: unknown) => request<T>('PUT', path, body),
  delete: <T = any>(path: string) => request<T>('DELETE', path),
};
