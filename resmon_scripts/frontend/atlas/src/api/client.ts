import createClient, { type Middleware } from 'openapi-fetch';
import type { paths } from './schema';
import { bridge } from '../bridge';

/**
 * The engine, typed from `docs/api-contract/openapi.json`.
 *
 * Every path, parameter and request body is checked against the generated
 * `paths`; a route that changes shape fails `npm run typecheck` until the
 * types are regenerated. The window's port and token come from the preload
 * bridge, which knows them only once the main process has chosen them, so the
 * client is built on first use and rebuilt if the port changes.
 */
export type Engine = ReturnType<typeof createClient<paths>>;

export class EngineError extends Error {
  /**
   * The engine's own sentence, where it refused with one (FastAPI's string
   * `detail`): "This routine is already running as execution 12…". A screen
   * shows this rather than the route and status, which say only that it failed.
   */
  readonly detail: string | null;

  constructor(readonly status: number, message: string, detail: string | null = null) {
    super(message);
    this.detail = detail;
  }
}

let cached: { port: string; client: Engine } | null = null;

const withToken: Middleware = {
  onRequest({ request }) {
    const token = bridge()?.getApiToken();
    if (token) request.headers.set('Authorization', `Bearer ${token}`);
    return request;
  },
};

export function engine(): Engine {
  const port = bridge()?.getBackendPort() ?? '';
  if (!port) throw new EngineError(0, 'This window has no backend connection yet.');
  if (!cached || cached.port !== port) {
    const client = createClient<paths>({ baseUrl: `http://127.0.0.1:${port}` });
    client.use(withToken);
    cached = { port, client };
  }
  return cached.client;
}

/**
 * The engine's own sentence in a refusal: FastAPI's string `detail`, or the
 * `message` of the Library's and Evidence's `{reason, message}` detail.
 */
export function engineSentence(error: unknown): string | null {
  const said = (error as { detail?: unknown } | undefined)?.detail;
  if (typeof said === 'string') return said;
  const message = said && typeof said === 'object' ? (said as { message?: unknown }).message : undefined;
  return typeof message === 'string' ? message : null;
}

/**
 * The body of a successful answer, or a thrown `EngineError` naming the route
 * and status. For TanStack Query, which shows a thrown read as a failure and
 * never as an empty result.
 */
export async function answer<T>(
  call: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T> {
  const { data, error, response } = await call;
  if (error !== undefined || data === undefined) {
    const route = new URL(response.url).pathname;
    throw new EngineError(response.status, `${route} answered HTTP ${response.status}`, engineSentence(error));
  }
  return data;
}
