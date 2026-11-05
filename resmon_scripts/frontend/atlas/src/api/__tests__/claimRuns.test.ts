import type { Middleware } from 'openapi-fetch';
import { STARTS_A_RUN, claimRuns } from '../client';

/** The bridge as the preload hands it over, with the run claim recorded. */
function withBridge(claimed: number[]): () => void {
  const host = window as unknown as { resmonAPI?: unknown };
  const before = host.resmonAPI;
  host.resmonAPI = {
    getBackendPort: () => '51234',
    getApiToken: () => 'token',
    runStarted: (id: number) => claimed.push(id),
  };
  return () => { host.resmonAPI = before; };
}

/** What the middleware reads of a request and its answer. */
function answered(schemaPath: string, body: unknown, { method = 'POST', ok = true } = {}) {
  return {
    schemaPath,
    request: { method } as Request,
    response: { ok, clone: () => ({ json: async () => body }) } as unknown as Response,
  } as Parameters<NonNullable<Middleware['onResponse']>>[0];
}

describe('a run this window starts is said to be this window\'s', () => {
  const onResponse = claimRuns.onResponse!;

  test('each route that starts a run, answered with its id, claims it', async () => {
    const claimed: number[] = [];
    const restore = withBridge(claimed);
    try {
      for (const route of STARTS_A_RUN) await onResponse(answered(route, { execution_id: 40 + claimed.length }));
      expect(claimed).toEqual([40, 41, 42, 43]);
    } finally {
      restore();
    }
  });

  test('nothing else claims: a read, a refusal, another route, an answer with no run, and outside the app', async () => {
    const claimed: number[] = [];
    const restore = withBridge(claimed);
    try {
      await onResponse(answered('/api/search/dive', { execution_id: 1 }, { method: 'GET' }));
      await onResponse(answered('/api/search/dive', { detail: 'refused' }, { ok: false }));
      await onResponse(answered('/api/routines', { execution_id: 2 }));
      await onResponse(answered('/api/routines/{routine_id}/run', { execution_id: null, queued: true }));
      await onResponse(answered('/api/search/sweep', 'not json'));
      expect(claimed).toEqual([]);
    } finally {
      restore();
    }
    // jsdom's own bridge has no claim: nothing is sent and nothing throws.
    await expect(onResponse(answered('/api/search/dive', { execution_id: 3 }))).resolves.toBeUndefined();
  });

  test('the answer is read from a copy, and handed on as it came', async () => {
    const restore = withBridge([]);
    try {
      expect(await onResponse(answered('/api/search/dive', { execution_id: 5 }))).toBeUndefined();
    } finally {
      restore();
    }
  });
});
