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

/** Calls the mock received for a path, across the whole test. */
export function callsTo(mock: jest.Mock, pathPrefix: string): Array<{ url: string; init?: RequestInit }> {
  return mock.mock.calls
    .map(([input, init]: [RequestInfo | URL, RequestInit?]) => ({ url: String(input), init }))
    .filter(({ url }) => url.replace(/^https?:\/\/[^/]+/, '').startsWith(pathPrefix));
}
