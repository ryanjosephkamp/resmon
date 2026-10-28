import { bridge } from './bridge';

/**
 * A request to this window's backend, with its token.
 *
 * A stand-in for the typed client generated from `docs/api-contract/openapi.json`,
 * which replaces it in the next step. It never retries on its own: whether a
 * failed read is shown, retried or kept stale is the data layer's decision.
 */
export class BackendError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export async function getJson<T>(path: string): Promise<T> {
  const b = bridge();
  if (!b || !b.getBackendPort()) throw new BackendError(0, 'This window has no backend connection yet.');
  const token = b.getApiToken();
  const response = await fetch(`http://127.0.0.1:${b.getBackendPort()}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) throw new BackendError(response.status, `${path} answered HTTP ${response.status}`);
  return (await response.json()) as T;
}
