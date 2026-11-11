import type { Middleware } from 'openapi-fetch';
import { CHANGES_THE_LOOK, CHANGES_THE_RUNS, STARTS_A_RUN, tellOtherWindows } from '../client';

/** The bridge as the preload hands it over, with each "the runs changed" and "the look changed" recorded. */
function withBridge(told: string[]): () => void {
  const host = window as unknown as { resmonAPI?: unknown };
  const before = host.resmonAPI;
  host.resmonAPI = {
    getBackendPort: () => '51234', getApiToken: () => 'token',
    runsChanged: () => told.push('told'), appearanceChanged: () => told.push('look'),
  };
  return () => { host.resmonAPI = before; };
}

function answered(schemaPath: string, { method = 'POST', ok = true } = {}) {
  return {
    schemaPath,
    request: { method } as Request,
    response: { ok } as Response,
  } as Parameters<NonNullable<Middleware['onResponse']>>[0];
}

describe('a window that changes the runs going now tells the others', () => {
  const onResponse = tellOtherWindows.onResponse!;

  test('the run monitor\'s seen, Stop, Don\'t run, and every route that starts a run', async () => {
    const told: string[] = [];
    const restore = withBridge(told);
    try {
      await onResponse(answered('/api/executions/seen'));
      await onResponse(answered('/api/executions/{exec_id}/cancel'));
      await onResponse(answered('/api/executions/waiting/{ticket}', { method: 'DELETE' }));
      for (const route of STARTS_A_RUN) await onResponse(answered(route));
      expect(told).toEqual(Array(3 + STARTS_A_RUN.size).fill('told'));
      expect(CHANGES_THE_RUNS.size).toBe(3 + STARTS_A_RUN.size);
    } finally {
      restore();
    }
  });

  test('the theme, the accent, the run monitor\'s switch, the top bar, and where links open tell the others the look changed', async () => {
    const told: string[] = [];
    const restore = withBridge(told);
    try {
      await onResponse(answered('/api/appearance', { method: 'PUT' }));
      await onResponse(answered('/api/top-bar', { method: 'PUT' }));
      await onResponse(answered('/api/web-links', { method: 'PUT' }));
      // A read, and a refusal, change nothing.
      await onResponse(answered('/api/appearance', { method: 'GET' }));
      await onResponse(answered('/api/top-bar', { method: 'PUT', ok: false }));
      expect(told).toEqual(['look', 'look', 'look']);
      expect([...CHANGES_THE_LOOK]).toEqual(['PUT /api/appearance', 'PUT /api/top-bar', 'PUT /api/web-links']);
    } finally {
      restore();
    }
  });

  test('nothing else: a read, a refusal, another method or route, and outside the app', async () => {
    const told: string[] = [];
    const restore = withBridge(told);
    try {
      await onResponse(answered('/api/executions/seen', { ok: false }));
      await onResponse(answered('/api/executions/active', { method: 'GET' }));
      await onResponse(answered('/api/executions/{exec_id}/cancel', { method: 'GET' }));
      await onResponse(answered('/api/executions/{exec_id}', { method: 'DELETE' }));
      await onResponse(answered('/api/routines'));
      expect(told).toEqual([]);
    } finally {
      restore();
    }
    // jsdom's own bridge has no way to tell: nothing is sent and nothing throws.
    expect(() => onResponse(answered('/api/executions/seen'))).not.toThrow();
  });
});
