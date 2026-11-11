import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { engine } from '../../../api/client';
import { StopUnfinished } from '../SourceStops';
import { RunningList } from '../ActiveList';
import { RunTabs } from '../RunTabs';
import { MemoryRouter } from 'react-router-dom';
import type { ActiveRun } from '../active';
import { LivePanel } from '../LivePanel';
import { liveSources, liveLabel, canStopUnfinished } from '../model';

jest.mock('../../../api/client', () => ({ ...jest.requireActual('../../../api/client'), engine: jest.fn() }));
const sources = liveSources(['arxiv', 'plos', 'zenodo'], [
  { type: 'repo_done', repository: 'arxiv', result_count: 2 },
  { type: 'repo_start', repository: 'plos' },
  { type: 'source_controls', sources: { arxiv: { stoppable: false }, plos: { stoppable: true }, zenodo: { stoppable: true } }, can_stop_unfinished: true },
]);
function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><LivePanel runId={7} sources={sources} names={new Map([['plos', 'PLOS']])} /></QueryClientProvider>);
}
test('only unfinished sources offer Stop This Source, and each refusal is shown', async () => {
  const POST = jest.fn(() => Promise.resolve({ error: { detail: 'PLOS has finished; it is too late to stop this source.' }, response: { status: 409, url: "http://127.0.0.1:1/api/executions/7/stop-sources" } }));
  (engine as jest.Mock).mockReturnValue({ POST });
  show();
  expect(screen.getAllByRole('button', { name: /Stop This Source/ })).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: 'Stop This Source: PLOS' }));
  expect(await screen.findByRole('status')).toHaveTextContent('PLOS has finished; it is too late');
  expect(POST).toHaveBeenCalledWith('/api/executions/{exec_id}/stop-sources', {
    params: { path: { exec_id: 7 } }, body: { sources: ['plos'] },
  });
  expect(screen.getByRole('button', { name: 'Stop This Source: zenodo' })).toBeEnabled();
});

test('source controls follow engine admission even when the display says not queried', () => {
  (engine as jest.Mock).mockReturnValue({ POST: jest.fn() });
  const client = new QueryClient();
  const live = liveSources(['govinfo', 'plos'], [
    { type: 'repo_skipped_missing_key', repository: 'govinfo' },
    { type: 'repo_stopped', repository: 'plos', result_count: 0 },
    { type: 'source_controls', sources: { govinfo: { stoppable: true }, plos: { stoppable: false }, arxiv: { stoppable: true } }, can_stop_unfinished: false },
  ]);
  render(<QueryClientProvider client={client}><LivePanel runId={7} sources={live} names={new Map()} /></QueryClientProvider>);
  expect(screen.getByRole('button', { name: 'Stop This Source: govinfo' })).toBeEnabled();
  expect(screen.queryByRole('button', { name: 'Stop This Source: plos' })).toBeNull();
});

test('RunningList names each bulk control by its run and removes it after Stop', async () => {
  (engine as jest.Mock).mockReturnValue({ POST: jest.fn(() => Promise.resolve({ data: { status: 'cancellation_requested' }, response: { status: 200 } })) });
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const events = [
    { type: 'repo_done', repository: 'arxiv', result_count: 2 },
    { type: 'source_controls', sources: { arxiv: { stoppable: false }, plos: { stoppable: true } }, can_stop_unfinished: true },
  ];
  const runs = [7, 8].map((id) => ({ id, execution_type: 'deep_sweep', query: `Graphs ${id}`, repositories: ['arxiv', 'plos'], events } as unknown as ActiveRun));
  render(<QueryClientProvider client={client}><MemoryRouter><RunningList running={runs} nameOf={(slug) => slug} watchName={() => null} /></MemoryRouter></QueryClientProvider>);
  expect(screen.getByRole('button', { name: 'Stop Unfinished Sources: Graphs 7' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Stop Unfinished Sources: Graphs 8' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Stop Graphs 7' }));
  expect(await screen.findByRole('button', { name: 'Stop Graphs 7' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Stop Unfinished Sources: Graphs 7' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Stop Unfinished Sources: Graphs 8' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Stop Graphs 8' }));
  await waitFor(() => {
    expect(screen.queryByRole('button', { name: 'Stop Unfinished Sources: Graphs 7' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Stop Unfinished Sources: Graphs 8' })).toBeNull();
  });
});
test('a stopped source is finished but never an answer, even with retained papers', () => {
  const [source] = liveSources(['plos'], [{ type: 'repo_stopped', repository: 'plos', result_count: 12, zero_message: 'PLOS was stopped by you; 12 records kept.' }]);
  expect(source?.state).toBe('stopped');
  expect(source?.count).toBe(12);
  expect(liveLabel(source!)).toBe('stopped by you');
});

test('bulk stopping is offered only with both finished and unfinished sources, and keeps its accepted sentence', async () => {
  (engine as jest.Mock).mockReturnValue({ POST: jest.fn(() => Promise.resolve({ data: {
    status: 'source_stop_requested', sources: ['plos'], detail: 'The sources will stop; the run will keep going.',
  }, response: { status: 200 } })) });
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const element = (available: boolean) => <QueryClientProvider client={client}><StopUnfinished runId={7} available={available} /></QueryClientProvider>;
  const { rerender } = render(element(false));
  expect(screen.queryByRole('button', { name: 'Stop Unfinished Sources' })).toBeNull();
  rerender(element(true));
  fireEvent.click(screen.getByRole('button', { name: 'Stop Unfinished Sources' }));
  expect(await screen.findByRole('status')).toHaveTextContent('The sources will stop; the run will keep going.');
  rerender(element(false));
  expect(screen.getByRole('status')).toHaveTextContent('The sources will stop; the run will keep going.');
});

test('skipped and stopped sources do not enable the bulk control without an engine answer', () => {
  expect(canStopUnfinished([
    { type: 'repo_skipped_missing_key', repository: 'govinfo' },
    { type: 'repo_stopped', repository: 'plos', result_count: 4 },
    { type: 'source_controls', sources: { govinfo: { stoppable: true }, plos: { stoppable: false }, arxiv: { stoppable: true } }, can_stop_unfinished: false },
  ])).toBe(false);
});

test('admission snapshots update controls without adding internal event names to the timeline', () => {
  render(<RunTabs run={{ id: 7 } as Parameters<typeof RunTabs>[0]['run']} live={[]} names={new Map()}
    events={[
      { type: 'execution_start', timestamp: '2026-11-08T20:00:00Z' },
      { type: 'source_controls', sources: { arxiv: { stoppable: true } }, can_stop_unfinished: false },
    ]} papers={null} running tab="Progress" onTab={() => undefined} />);
  expect(screen.getByText('The run started.')).toBeVisible();
  expect(screen.queryByText('source controls')).toBeNull();
  expect(document.querySelectorAll('.events li')).toHaveLength(1);
});
