/**
 * Shared helpers for renderer tests.
 *
 * Pages call several endpoints on mount (their own data, plus what
 * ExecutionProvider fetches), so tests describe a route table instead of a
 * single canned payload. Unrouted URLs fail loudly — a test that silently
 * 200s an endpoint it never considered is how coverage lies.
 */

import React from 'react';
import { act, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ExecutionProvider } from '../context/ExecutionContext';

export type RouteTable = Record<string, unknown | ((url: string, init?: RequestInit) => unknown)>;

/** Defaults every page needs because ExecutionProvider mounts with it. */
const PROVIDER_ROUTES: RouteTable = {
  '/api/executions/active': { active_ids: [] },
  '/api/settings/notifications': {},
};

export function mockRoutedFetch(routes: RouteTable): jest.Mock {
  const table = { ...PROVIDER_ROUTES, ...routes };
  const mock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    const withQuery = url.replace(/^https?:\/\/[^/]+/, '');
    const entry =
      table[withQuery] !== undefined ? table[withQuery]
      : table[path] !== undefined ? table[path]
      : undefined;
    if (entry === undefined) {
      throw new Error(`Unrouted fetch in test: ${withQuery}`);
    }
    const payload = typeof entry === 'function' ? (entry as Function)(url, init) : entry;
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    };
  });
  (global as any).fetch = mock;
  return mock;
}

export async function renderWithProviders(ui: React.ReactElement, initialEntries: string[] = ['/']) {
  await act(async () => {
    render(
      <MemoryRouter initialEntries={initialEntries}>
        <ExecutionProvider>{ui}</ExecutionProvider>
      </MemoryRouter>,
    );
  });
}

/**
 * Put the default desktop bridge back on `window`.
 *
 * `jest.setup.js` installs one before the file's first test, and a test that
 * replaces it to exercise a picker used to clean up with `delete`. That left
 * every later test in the file with no bridge at all, which the renderer
 * tolerated only because `getBaseUrl()` guessed the daemon's port when nobody
 * told it one. It does not guess any more, so a `delete` in a cleanup hook now
 * takes the backend away from the tests that follow. Restore it instead; a test
 * that means to have no bridge says so in its own body.
 */
export function restoreDesktopBridge(): void {
  (window as unknown as { resmonAPI: Record<string, unknown> }).resmonAPI = {
    getBackendPort: () => '51234',
  };
}

/** Calls the mock received for a path, across the whole test. */
export function callsTo(mock: jest.Mock, pathPrefix: string): Array<{ url: string; init?: RequestInit }> {
  return mock.mock.calls
    .map(([input, init]: [RequestInfo | URL, RequestInit?]) => ({ url: String(input), init }))
    .filter(({ url }) => url.replace(/^https?:\/\/[^/]+/, '').startsWith(pathPrefix));
}
