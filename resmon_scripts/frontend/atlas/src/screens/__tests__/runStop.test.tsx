/**
 * The run's own page when the engine refuses its Stop because the run is
 * already finishing: the engine's sentence is a status, Stop reads
 * "Finishing…", and nothing is shown as a failure.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { engine } from '../../api/client';
import { Run } from '../Run';

jest.mock('../../api/client', () => ({ ...jest.requireActual('../../api/client'), engine: jest.fn() }));

jest.mock('../runs/RunSky', () => ({ RunSky: () => null }));
jest.mock('../runs/RunMap', () => ({ RunMap: ({ runId, compact }: { runId: number; compact?: boolean }) => <div data-run-map={runId} data-compact={!!compact} /> }));
jest.mock('../sky/MapPaper', () => ({ MapPaper: () => null }));

const SENTENCE = 'Execution 7 is finishing; it is too late to cancel it.';
const RUN = {
  id: 7, execution_type: 'deep_dive', status: 'running', start_time: '2026-11-06T10:00:00Z', end_time: null,
  parameters: { query: 'tidal', repositories: ['arxiv'] }, repositories: ['arxiv'], routine_id: null,
  restarted_into: [], restarted_from: null, coverage: { sources: [], additional_sources: [], notes: [], summary: 'No sources answered.' }, result_count: 0, new_result_count: 0,
};
const reply = (data: unknown, status = 200, error?: unknown) => Promise.resolve({
  data: error === undefined ? data : undefined, error, response: { url: 'http://127.0.0.1:1/api/x', status } as Response,
});

const LIVE = [
  { type: 'repo_done', repository: 'arxiv', result_count: 2 },
  { type: 'repo_start', repository: 'plos' },
  { type: 'source_controls', sources: { arxiv: { stoppable: false }, plos: { stoppable: true } }, can_stop_unfinished: true },
];

test.each([200, 409])('source controls disappear when Stop is accepted or finishing (%s)', async (status) => {
  const GET = jest.fn((route: string) => reply(route.endsWith('progress/events') ? LIVE : route === '/api/executions/{exec_id}'
    ? { ...RUN, repositories: ['arxiv', 'plos'] } : []));
  const POST = jest.fn(() => status === 200 ? reply({ status: 'cancellation_requested' }) : reply(undefined, 409, { detail: SENTENCE }));
  (engine as jest.Mock).mockReturnValue({ GET, POST });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/runs/7']}><Routes>
    <Route path="/runs/:id" element={<Run />} />
  </Routes></MemoryRouter></QueryClientProvider>);
  await screen.findByRole('button', { name: /Stop This Source: plos/ });
  fireEvent.click(screen.getByRole('button', { name: /^Stop$/ }));
  await screen.findByRole('button', { name: status === 200 ? /Stopping/ : /Finishing/ });
  expect(screen.queryByRole('button', { name: /Stop This Source/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /Stop Unfinished Sources/ })).toBeNull();
});

test.each(['', '/map'])('exactly one map of the run is drawn on its %s view', async (suffix) => {
  (engine as jest.Mock).mockReturnValue({ GET: jest.fn((route: string) => reply(route === '/api/executions/{exec_id}' ? RUN : [])) });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[`/runs/7${suffix}`]}><Routes>
    <Route path="/runs/:id/:tab?" element={<Run />} />
  </Routes></MemoryRouter></QueryClientProvider>);
  await screen.findByRole('button', { name: /^Stop$/ });
  expect(document.querySelectorAll('[data-run-map="7"]')).toHaveLength(1);
  expect(document.querySelector('[data-run-map="7"]')).toHaveAttribute('data-compact', suffix ? 'false' : 'true');
});

test('a refused Stop on the run page says the engine\'s sentence and is not an alert', async () => {
  const GET = jest.fn((route: string) => reply(route.endsWith('progress/events') ? [] : route === '/api/executions/{exec_id}' ? RUN : []));
  const POST = jest.fn(() => reply(undefined, 409, { detail: SENTENCE }));
  (engine as jest.Mock).mockReturnValue({ GET, POST });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/runs/7']}><Routes><Route path="/runs/:id" element={<Run />} /></Routes></MemoryRouter>
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole('button', { name: /^Stop$/ }));
  await waitFor(() => expect(document.querySelector('[data-run="finishing"]')).toHaveTextContent(SENTENCE));
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByRole('button', { name: /^Finishing/ })).toBeDisabled();
  expect(document.querySelector('.run')?.getAttribute('data-status')).toBe('running');
});


test.each(['completed', 'cancelled', 'error'])('source stop notices disappear as the run becomes %s', async (status) => {
  const sentence = 'PLOS will stop at its next safe point; the run will keep going.';
  (engine as jest.Mock).mockReturnValue({
    GET: jest.fn((route: string) => reply(route.endsWith('progress/events') ? LIVE : route === '/api/executions/{exec_id}'
      ? { ...RUN, repositories: ['arxiv', 'plos'] } : [])),
    POST: jest.fn(() => reply({ status: 'source_stop_requested', sources: ['plos'], detail: sentence })),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/runs/7']}><Routes>
    <Route path="/runs/:id" element={<Run />} />
  </Routes></MemoryRouter></QueryClientProvider>);
  fireEvent.click(await screen.findByRole('button', { name: /Stop Unfinished Sources/ }));
  await screen.findByText(sentence);
  act(() => { client.setQueryData(['run', 7], { ...RUN, status, end_time: '2026-11-06T10:01:00Z' }); });
  await waitFor(() => expect(screen.queryByText(sentence)).not.toBeInTheDocument());
});
