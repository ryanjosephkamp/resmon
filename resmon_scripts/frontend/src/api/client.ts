declare global {
  interface Window {
    resmonAPI?: {
      getBackendPort: () => string;
      platform: string;
      versions: { node: string; electron: string };
      chooseDirectory?: (defaultPath?: string) => Promise<string | null>;
      openPath?: (targetPath: string) => Promise<string>;
      revealPath?: (targetPath: string) => Promise<boolean>;
      cloudAuth?: {
        signIn: () => Promise<{ access_token: string; email: string; expires_in: number }>;
        signOut: () => Promise<{ signed_in: false }>;
        refresh: () => Promise<{ access_token: string; expires_in: number }>;
        status: () => Promise<{ signed_in: boolean; email: string; sync_state: string }>;
        setSync: (enabled: boolean) => Promise<{ sync_state: string }>;
      };
    };
  }
}

export function getBaseUrl(): string {
  const port = window.resmonAPI?.getBackendPort() || '8742';
  return `http://127.0.0.1:${port}`;
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
