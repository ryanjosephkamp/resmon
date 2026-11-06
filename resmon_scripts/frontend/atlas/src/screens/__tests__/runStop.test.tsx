/**
 * The run's own page when the engine refuses its Stop because the run is
 * already finishing: the engine's sentence is a status, Stop reads
 * "Finishing…", and nothing is shown as a failure.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { engine } from '../../api/client';
import { Run } from '../Run';

jest.mock('../../api/client', () => ({ ...jest.requireActual('../../api/client'), engine: jest.fn() }));

jest.mock('../runs/RunSky', () => ({ RunSky: () => null }));
jest.mock('../sky/MapPaper', () => ({ MapPaper: () => null }));

const SENTENCE = 'Execution 7 is finishing; it is too late to cancel it.';
const RUN = {
  id: 7, execution_type: 'deep_dive', status: 'running', start_time: '2026-11-06T10:00:00Z', end_time: null,
  parameters: { query: 'tidal', repositories: ['arxiv'] }, repositories: ['arxiv'], routine_id: null,
  restarted_into: [], restarted_from: null, coverage: { sources: [], additional_sources: [] }, result_count: 0, new_result_count: 0,
};
const reply = (data: unknown, status = 200, error?: unknown) => Promise.resolve({
  data: error === undefined ? data : undefined, error, response: { url: 'http://127.0.0.1:1/api/x', status } as Response,
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
  fireEvent.click(await screen.findByRole('button', { name: /^Stop/ }));
  await waitFor(() => expect(document.querySelector('[data-run="finishing"]')).toHaveTextContent(SENTENCE));
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByRole('button', { name: /^Finishing/ })).toBeDisabled();
  expect(document.querySelector('.run')?.getAttribute('data-status')).toBe('running');
});
