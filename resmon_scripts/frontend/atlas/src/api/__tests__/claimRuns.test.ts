import type { Middleware } from 'openapi-fetch';
import { STARTS_A_RUN, claimRuns } from '../client';

/** The bridge as the preload hands it over, with the run claims recorded. */
function withBridge(claimed: number[], queued: unknown[] = []): () => void {
  const host = window as unknown as { resmonAPI?: unknown };
  const before = host.resmonAPI;
  host.resmonAPI = {
    getBackendPort: () => '51234',
    getApiToken: () => 'token',
    runStarted: (id: number) => claimed.push(id),
    runQueued: (what: unknown) => queued.push(what),
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
      expect(claimed).toEqual([40, 41, 42, 43, 44]);
      expect(STARTS_A_RUN.has('/api/find')).toBe(true);
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

  test('a run queued at the run limit is claimed by its ticket, or by its watch for Run Now', async () => {
    const claimed: number[] = [];
    const queued: unknown[] = [];
    const restore = withBridge(claimed, queued);
    try {
      await onResponse(answered('/api/search/sweep', { execution_id: null, queued: true, queue_position: 2, ticket: 'tk-9' }));
      await onResponse(answered('/api/executions/{exec_id}/restart', { execution_id: null, restarted_from: 4, queued: true, ticket: 'tk-10' }));
      await onResponse(answered('/api/routines/{routine_id}/run', { execution_id: null, routine_id: 3, queued: true, queue_position: 1 }));
      expect(claimed).toEqual([]);
      expect(queued).toEqual([{ ticket: 'tk-9' }, { ticket: 'tk-10' }, { routineId: 3 }]);
    } finally {
      restore();
    }
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
