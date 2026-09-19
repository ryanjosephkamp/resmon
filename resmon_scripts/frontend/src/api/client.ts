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

export function getBaseUrl(): string {
  const port = window.resmonAPI?.getBackendPort() || '8742';
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

/** `fetch` against the backend: `path` is appended to `getBaseUrl()`, the token is added. */
export function backendFetch(path: string, init: RequestInit = {}): Promise<Response> {
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
