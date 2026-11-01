/**
 * Today and the map are kept between visits, and read again when something
 * changes them: each named change marks what it makes out of date, and a run
 * that has ended since the last reading is a change, wherever it ended.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, waitFor } from '@testing-library/react';
import { engine } from '../../../api/client';
import { LIFECYCLE_FOR } from '../../lifecycle/model';
import {
  FACETS_KEY, KEPT_MS, MAP_KEY, READ_AGAIN, TODAY_KEY, endedRuns, forgetRunsEnded, invalidateFor, keepBetweenVisits,
  mapKeptFor, useRunEnding, useRunsEnded, type Change,
} from '../freshness';

jest.mock('../../../api/client', () => ({ ...jest.requireActual('../../../api/client'), engine: jest.fn() }));

// jsdom has no `Response`; `answer` reads only `data` and `error` on success.
const reply = (data: unknown) => Promise.resolve({ data, error: undefined, response: {} as Response });

function filled(): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  keepBetweenVisits(client);
  client.setQueryData(TODAY_KEY, { total: 3 });
  client.setQueryData(MAP_KEY, { state: 'ready' });
  client.setQueryData(FACETS_KEY, { sources: [] });
  return client;
}

const stale = (client: QueryClient, key: readonly unknown[]) => client.getQueryState(key)?.isInvalidated ?? false;

test('Today, the map, and what is recorded against listed papers are kept for the minute between refreshes', () => {
  const client = new QueryClient();
  keepBetweenVisits(client);
  expect(KEPT_MS).toBe(60_000);
  expect(client.getQueryDefaults(TODAY_KEY).staleTime).toBe(KEPT_MS);
  expect(client.getQueryDefaults([LIFECYCLE_FOR, [1, 2]]).staleTime).toBe(KEPT_MS);
  expect(typeof client.getQueryDefaults(MAP_KEY).staleTime).toBe('function');
});

test('a drawn map is kept, and one still being fitted is asked for again by the next page that opens', () => {
  expect(mapKeptFor({ state: 'ready', refitting: false })).toBe(KEPT_MS);
  expect(mapKeptFor({ state: 'ready', refitting: true })).toBe(0);
  expect(mapKeptFor({ state: 'fitting' })).toBe(0);
  expect(mapKeptFor({ state: 'failed' })).toBe(0);
  expect(mapKeptFor(undefined)).toBe(0);
});

test.each(Object.keys(READ_AGAIN) as Change[])('“%s” reads again exactly what it makes out of date', async (change) => {
  const client = filled();
  await invalidateFor(client, change);
  const named = READ_AGAIN[change].map((key) => key[0]);
  for (const key of [TODAY_KEY, MAP_KEY, FACETS_KEY]) expect(stale(client, key)).toBe(named.includes(key[0]));
});

test('a run finishing reads Today, the map, and the facets again; a watch or a paper changing leaves the map', () => {
  expect(READ_AGAIN['run-finished']).toEqual([TODAY_KEY, MAP_KEY, FACETS_KEY]);
  expect(READ_AGAIN['watch-changed']).not.toContain(MAP_KEY);
  expect(READ_AGAIN['paper-changed']).not.toContain(MAP_KEY);
});

test('only runs that have ended count: a run starting has no papers yet', () => {
  expect(endedRuns([{ id: 9, status: 'running' }, { id: 8, status: 'completed' }, { id: 7, status: 'cancelling' }])).toBe('8');
  expect(endedRuns([{ id: 9, status: 'failed' }, { id: 8, status: 'completed' }])).toBe('9,8');
});

describe('a run that ended since the last reading', () => {
  let GET: jest.Mock;
  beforeEach(() => {
    forgetRunsEnded();
    GET = jest.fn();
    (engine as jest.Mock).mockReturnValue({ GET });
  });
  afterEach(() => { jest.resetAllMocks(); });

  function Reader() {
    useRunsEnded();
    return null;
  }

  test('reads Today and the map again on the next visit, without waiting for the refresh', async () => {
    const client = filled();
    GET.mockReturnValue(reply([{ id: 9, status: 'running' }, { id: 8, status: 'completed' }]));
    const first = render(<QueryClientProvider client={client}><Reader /></QueryClientProvider>);
    await waitFor(() => expect(GET).toHaveBeenCalledTimes(1));
    first.unmount();
    expect(stale(client, TODAY_KEY)).toBe(false);

    // Back on Today: run 9 has ended in the meantime.
    GET.mockReturnValue(reply([{ id: 9, status: 'completed' }, { id: 8, status: 'completed' }]));
    render(<QueryClientProvider client={client}><Reader /></QueryClientProvider>);
    await waitFor(() => expect(stale(client, TODAY_KEY)).toBe(true));
    expect(stale(client, MAP_KEY)).toBe(true);
    expect(GET).toHaveBeenCalledWith('/api/executions', { params: { query: { limit: 5 } } });
  });

  test('keeps them when nothing has ended, and when a run has only started', async () => {
    const client = filled();
    GET.mockReturnValue(reply([{ id: 8, status: 'completed' }]));
    const first = render(<QueryClientProvider client={client}><Reader /></QueryClientProvider>);
    await waitFor(() => expect(GET).toHaveBeenCalledTimes(1));
    first.unmount();

    GET.mockReturnValue(reply([{ id: 9, status: 'running' }, { id: 8, status: 'completed' }]));
    render(<QueryClientProvider client={client}><Reader /></QueryClientProvider>);
    await waitFor(() => expect(GET).toHaveBeenCalledTimes(2));
    expect(stale(client, TODAY_KEY)).toBe(false);
    expect(stale(client, MAP_KEY)).toBe(false);
  });
});

test('a page that watched a run going reports it when the run is going no longer', () => {
  const client = filled();
  function Watching({ running }: { running: number | null }) {
    useRunEnding(running);
    return null;
  }
  const page = render(<QueryClientProvider client={client}><Watching running={null} /></QueryClientProvider>);
  page.rerender(<QueryClientProvider client={client}><Watching running={12} /></QueryClientProvider>);
  expect(stale(client, TODAY_KEY)).toBe(false);
  page.rerender(<QueryClientProvider client={client}><Watching running={null} /></QueryClientProvider>);
  expect(stale(client, TODAY_KEY)).toBe(true);
  expect(stale(client, MAP_KEY)).toBe(true);
});

test('a page opened on a run already over reports nothing', () => {
  const client = filled();
  function Watching({ running }: { running: number | null }) {
    useRunEnding(running);
    return null;
  }
  const page = render(<QueryClientProvider client={client}><Watching running={null} /></QueryClientProvider>);
  page.rerender(<QueryClientProvider client={client}><Watching running={null} /></QueryClientProvider>);
  expect(stale(client, TODAY_KEY)).toBe(false);
});
