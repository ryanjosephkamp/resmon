import { act, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { engine } from '../../api/client';
import { ACTIVE_KEY, type ActiveRuns } from '../../screens/runs/active';
import { invalidateFor } from '../../screens/today/freshness';
import { CollectionSwitcher } from '../CollectionSwitcher';
import { CollectionProvider, type CollectionList } from '../current';
import { afterPapersChanged } from '../papers';

jest.mock('../../api/client', () => ({ ...jest.requireActual('../../api/client'), engine: jest.fn() }));

const IDLE: ActiveRuns = {
  active_ids: [], running: [], waiting: [], max_concurrent: 3, queue_limit: 16, failed_unseen: [], seen_at: null,
  newest_run_id: null, last_ended_at: null,
};
const MEMBERSHIP_VIEWS = [
  'explorer', 'explorer-facets', 'analytics-overview', 'keyword-contribution', 'publication-volume',
  'today', 'map', 'map-facets', 'paper', 'reading-queue',
];
const reply = (data: unknown) => Promise.resolve({ data, error: undefined, response: {} as Response });

function setup() {
  const state = { papers: 0, active: IDLE };
  (engine as jest.Mock).mockReturnValue({ GET: (path: string) => {
    if (path === '/api/executions/active') return reply(state.active);
    if (path !== '/api/collections') throw new Error(`Unexpected read: ${path}`);
    const list: CollectionList = {
      current_id: 1, default_id: 1,
      collections: [{ id: 1, name: 'Main Collection', is_default: true, papers: state.papers, watches: 0,
        created_at: '2026-11-01T08:00:00Z' }],
    };
    return reply(list);
  } });
  // Match the app: a mounted query does not refresh on focus unless it asks to.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  function Total({ view }: { view: string }) {
    const total = useQuery({ queryKey: [view, 1], queryFn: async () => state.papers });
    return <p>{view}: {total.data ?? 'reading'}</p>;
  }
  const mounted = render(
    <QueryClientProvider client={client}><MemoryRouter><CollectionProvider>
      <CollectionSwitcher />
      {MEMBERSHIP_VIEWS.map((view) => <Total key={view} view={view} />)}
    </CollectionProvider></MemoryRouter></QueryClientProvider>,
  );
  return { state, client, ...mounted };
}

async function expectEveryCount(papers: number): Promise<void> {
  await waitFor(() => {
    expect(screen.getByRole('menuitemradio', { hidden: true })).toHaveTextContent(`Main Collection${papers}`);
    for (const view of MEMBERSHIP_VIEWS) expect(screen.getByText(`${view}: ${papers}`)).toBeInTheDocument();
  });
}

afterEach(() => { jest.resetAllMocks(); jest.useRealTimers(); });

test('a run ending between active-run polls updates the mounted switcher, Search, and Analytics', async () => {
  const { state, client } = setup();
  await expectEveryCount(0);
  state.papers = 1;
  state.active = { ...IDLE, newest_run_id: 7, last_ended_at: '2026-11-07T12:00:00Z' };
  act(() => { client.setQueryData(ACTIVE_KEY, state.active); });
  await expectEveryCount(1);
});

test('a minute refresh sees a membership change in another window and refreshes all count views', async () => {
  jest.useFakeTimers();
  const { state } = setup();
  await expectEveryCount(0);
  state.papers = 1;
  await act(async () => { jest.advanceTimersByTime(60_000); });
  await expectEveryCount(1);
});

test('native window focus refreshes membership views and a cached empty map while the window stayed visible', async () => {
  const { state, client } = setup();
  await expectEveryCount(0);
  client.setQueryData(['map', 2], { state: 'empty' });
  state.papers = 1;
  act(() => { window.dispatchEvent(new Event('focus')); });
  await expectEveryCount(1);
  expect(client.getQueryState(['map', 2])?.isInvalidated).toBe(true);
});

test('copy, move, undo, and collection removal refresh Analytics along with the other membership reads', async () => {
  const { state, client } = setup();
  await expectEveryCount(0);
  state.papers = 1;
  await act(async () => { await afterPapersChanged(client); });
  await expectEveryCount(1);
});

test('a run-finished notification invalidates every saved membership view, including collections not shown', async () => {
  const client = new QueryClient();
  const keys = [['collections'], ...MEMBERSHIP_VIEWS.flatMap((view) => [[view, 1], [view, 2]])];
  for (const key of keys) client.setQueryData(key, { papers: 0 });
  await invalidateFor(client, 'run-finished');
  for (const key of keys) expect(client.getQueryState(key)?.isInvalidated).toBe(true);
});
