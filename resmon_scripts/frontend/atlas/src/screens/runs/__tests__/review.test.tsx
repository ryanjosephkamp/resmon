/**
 * The Runs tab and the run monitor, held to what a reader should see when the
 * runs change around them: a list that comes back after a run ended reads
 * itself again; the history's read-ahead never calls off its own reading and
 * never asks for a failing page in a loop; the monitor's end ring plays once;
 * the question asked in place gives the focus back; and opening the panel
 * always tells the engine the failures until now are seen; and Restart,
 * weighed from the history, says what the run was set to do with summaries.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { engine } from '../../../api/client';
import { ACTIVE_KEY, forgetAnswered, useReadAgainWhenRunsChange, type ActiveRuns } from '../active';
import { Confirm } from '../Confirm';
import { RunHistory } from '../RunHistory';
import { RunMark } from '../RunMark';
import { RunMonitor } from '../RunMonitor';
import type { RunRow } from '../model';

jest.mock('../../../api/client', () => ({ ...jest.requireActual('../../../api/client'), engine: jest.fn() }));

const reply = (data: unknown, total?: number) => Promise.resolve({
  data, error: undefined,
  response: { url: 'http://127.0.0.1:1/x', status: 200, headers: { get: () => (total === undefined ? null : String(total)) } } as unknown as Response,
});
const failure = () => Promise.resolve({
  data: undefined, error: { detail: 'no' },
  response: { url: 'http://127.0.0.1:1/api/executions', status: 500, headers: { get: () => null } } as unknown as Response,
});

const active = (newest: number, failed: number[] = []): ActiveRuns => ({
  active_ids: [], running: [], waiting: [], max_concurrent: 3, queue_limit: 16, failed_unseen: failed, seen_at: null,
  newest_run_id: newest, last_ended_at: null,
});

const run = (id: number): RunRow => ({
  id, execution_type: 'deep_dive', routine_id: null, status: 'completed', start_time: '2026-11-04T18:00:00Z',
  keywords: [`terms ${id}`], query: `terms ${id}`, parameters: '{}',
  coverage: { counts: { answered: 1, non_answer: 0, in_part: 0 }, total: 1 },
  total_results: 1, new_results: 1, result_count: 1, new_result_count: 1, error_message: null,
}) as unknown as RunRow;

function withClient(client: QueryClient, node: React.ReactNode) {
  return <QueryClientProvider client={client}><MemoryRouter>{node}</MemoryRouter></QueryClientProvider>;
}

beforeEach(() => {
  forgetAnswered();
  jest.clearAllMocks();
});

describe('a list of runs that was not on screen when a run ended', () => {
  function Probe() {
    useReadAgainWhenRunsChange('probe', ['probe-list']);
    return null;
  }

  test('reads itself again when it comes back, though the signature it finds is already the new one', async () => {
    let now = active(1);
    (engine as jest.Mock).mockReturnValue({ GET: jest.fn(() => reply(now)) });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = jest.spyOn(client, 'invalidateQueries');
    const first = render(withClient(client, <Probe />));
    await waitFor(() => expect(client.getQueryData(ACTIVE_KEY)).toEqual(active(1)));
    first.unmount();
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['probe-list'] });

    // While it was away the run monitor read the change (a run ended): the cache already holds it.
    now = active(2);
    client.setQueryData(ACTIVE_KEY, now);
    render(withClient(client, <Probe />));
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['probe-list'] }));
  });
});

describe('the history’s read-ahead', () => {
  let observed: ((entries: { isIntersecting: boolean }[]) => void) | null = null;
  beforeEach(() => {
    observed = null;
    (window as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class {
      constructor(callback: (entries: { isIntersecting: boolean }[]) => void) { observed = callback; }
      observe() {}
      disconnect() { observed = null; }
    };
  });

  const offsets = (GET: jest.Mock) => GET.mock.calls
    .filter(([route]) => route === '/api/executions')
    .map(([, init]) => (init as { params: { query: { offset: number } } }).params.query.offset);

  test('does not call off the list’s own reading again: no page is asked for while it is read again', async () => {
    let hold = false;
    const GET = jest.fn((route: string, init: { params: { query: { offset: number } } }) => {
      if (route === '/api/executions/active') return reply(active(1));
      if (route === '/api/routines') return reply([]);
      if (hold && init.params.query.offset === 0) return new Promise(() => {});
      return reply([run(100 - init.params.query.offset)], 100);
    });
    (engine as jest.Mock).mockReturnValue({ GET });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(withClient(client, <RunHistory filter="all" words="" watchName={() => null} notice={null} />));
    await screen.findByText('terms 100');
    await waitFor(() => expect(observed).not.toBeNull());
    // The list is read again (a run ended), and that reading is still out when the end comes into view.
    hold = true;
    act(() => { void client.invalidateQueries({ queryKey: ['runs', 'history'] }); });
    await waitFor(() => expect(offsets(GET).filter((o) => o === 0)).toHaveLength(2));
    act(() => observed?.([{ isIntersecting: true }]));
    expect(offsets(GET)).not.toContain(1);
  });

  test('does not ask for a page that could not be read again and again while the end stays in view', async () => {
    const GET = jest.fn((route: string, init: { params: { query: { offset: number } } }) => {
      if (route === '/api/executions/active') return reply(active(1));
      if (route === '/api/routines') return reply([]);
      return init.params.query.offset === 0 ? reply([run(100)], 100) : failure();
    });
    (engine as jest.Mock).mockReturnValue({ GET });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(withClient(client, <RunHistory filter="all" words="" watchName={() => null} notice={null} />));
    await screen.findByText('terms 100');
    await waitFor(() => expect(observed).not.toBeNull());
    act(() => observed?.([{ isIntersecting: true }]));
    await waitFor(() => expect(offsets(GET).filter((o) => o === 1)).toHaveLength(1));
    // It failed; the end is still in view. Nothing more is asked for on its own.
    await waitFor(() => expect(observed).toBeNull());
    act(() => observed?.([{ isIntersecting: true }]));
    await new Promise((r) => setTimeout(r, 50));
    expect(offsets(GET).filter((o) => o === 1)).toHaveLength(1);
    // Older runs asks once more, by hand.
    fireEvent.click(screen.getByRole('button', { name: /^Older runs/ }));
    await waitFor(() => expect(offsets(GET).filter((o) => o === 1)).toHaveLength(2));
  });
});

describe('Restart weighed from the history', () => {
  beforeEach(() => {
    (window as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class {
      observe() {}
      disconnect() {}
    };
  });

  test('says a failed run set to summarize is restarted with summaries on, from its ai_choice, though no lane was tried', async () => {
    const failed = { ...run(31), status: 'failed', error_message: 'Unknown repository: crossref' } as RunRow;
    const GET = jest.fn((route: string) => {
      if (route === '/api/executions/active') return reply(active(31));
      if (route === '/api/routines') return reply([]);
      if (route === '/api/executions/{exec_id}/progress/events') {
        return reply([{ type: 'execution_start' }, { type: 'ai_choice', enabled: true, lane_source: 'settings', lanes: [], adjusted: [] }]);
      }
      return reply([failed], 1);
    });
    (engine as jest.Mock).mockReturnValue({ GET });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(withClient(client, <RunHistory filter="all" words="" watchName={() => null} notice={null} />));
    fireEvent.click(await screen.findByRole('button', { name: /^Restart…/ }));
    expect(await screen.findByText(/^This run was set to summarize, so Restart does too/)).toBeTruthy();
    expect(GET).toHaveBeenCalledWith('/api/executions/{exec_id}/progress/events', { params: { path: { exec_id: 31 } } });
  });
});

describe('the run monitor’s end ring', () => {
  test('plays once per run that ends, not again when the mark changes state', () => {
    const { container, rerender } = render(<RunMark state="idle" pulse={1} />);
    const ring = container.querySelector('.rm-pulse');
    expect(ring).not.toBeNull();
    rerender(<RunMark state="running" orbits={[{ share: 0, stalled: false }]} pulse={1} />);
    expect(container.querySelector('.rm-pulse')).toBe(ring);
    rerender(<RunMark state="failed" pulse={1} />);
    expect(container.querySelector('.rm-pulse')).toBe(ring);
    rerender(<RunMark state="idle" pulse={2} />);
    expect(container.querySelector('.rm-pulse')).not.toBe(ring);
  });
});

describe('the question asked in place', () => {
  test('gives the focus back to the button that asked, whichever way it goes', () => {
    function Asker({ asking }: { asking: boolean }) {
      return (
        <>
          <button type="button">Delete</button>
          {asking && <Confirm name="q" question="Delete it?" act="Delete it" onAct={() => {}} onCancel={() => {}} />}
        </>
      );
    }
    const { rerender } = render(<Asker asking={false} />);
    const asked = screen.getByRole('button', { name: 'Delete' });
    asked.focus();
    rerender(<Asker asking />);
    expect(document.activeElement).toBe(screen.getByRole('group', { name: 'Delete it' }));
    rerender(<Asker asking={false} />);
    expect(document.activeElement).toBe(asked);
  });
});

describe('opening the run monitor’s panel', () => {
  test('tells the engine the failures until now are seen, every time, even when none was known', async () => {
    const POST = jest.fn(() => reply({ seen_at: '2026-11-04T18:00:00Z' }));
    const GET = jest.fn((route: string) => reply(route === '/api/executions/active' ? active(1) : []));
    (engine as jest.Mock).mockReturnValue({ GET, POST });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(withClient(client, <RunMonitor />));
    await waitFor(() => expect(client.getQueryData(ACTIVE_KEY)).toEqual(active(1)));
    const panel = screen.getByRole('dialog', { hidden: true });
    const toggle = (state: 'open' | 'closed') => {
      const event = new Event('toggle');
      Object.assign(event, { newState: state, oldState: state === 'open' ? 'closed' : 'open' });
      act(() => { panel.dispatchEvent(event); });
    };
    toggle('open');
    await waitFor(() => expect(POST).toHaveBeenCalledWith('/api/executions/seen'));
    toggle('closed');
    toggle('open');
    await waitFor(() => expect(POST).toHaveBeenCalledTimes(2));
  });
});
