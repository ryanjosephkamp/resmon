/**
 * A Stop the engine refused because the run is already finishing (HTTP 409):
 * the screen says the engine's sentence as a plain status, leaves the run
 * looking like the running run it still is, and does not call it a failure.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { engine, EngineError, stopRefusal } from '../../../api/client';
import { RunningList } from '../ActiveList';
import type { ActiveRun } from '../active';

jest.mock('../../../api/client', () => ({ ...jest.requireActual('../../../api/client'), engine: jest.fn() }));

const SENTENCE = 'Execution 7 is finishing; it is too late to cancel it.';
const run = {
  id: 7, execution_type: 'deep_dive', status: 'running', start_time: '2026-11-06T10:00:00Z',
  repositories: ['arxiv'], events: [], routine_id: null, parameters: {},
} as unknown as ActiveRun;

const refused = (status: number, detail: string) => Promise.resolve({
  data: undefined, error: { detail }, response: { url: 'http://127.0.0.1:1/api/executions/7/cancel', status } as Response,
});

function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter><RunningList running={[run]} nameOf={(s) => s} watchName={() => null} /></MemoryRouter>
    </QueryClientProvider>,
  );
}

test('a 409 from the engine is its sentence, said as a status, not an alert', () => {
  expect(stopRefusal(new EngineError(409, 'x', SENTENCE))).toBe(SENTENCE);
  expect(stopRefusal(new EngineError(500, 'x', SENTENCE))).toBeNull();
  expect(stopRefusal(new Error('network'))).toBeNull();
});

test('the Runs list shows the engine\'s sentence for a refused Stop and keeps the run running', async () => {
  const POST = jest.fn(() => refused(409, SENTENCE));
  (engine as jest.Mock).mockReturnValue({ POST, GET: jest.fn(() => refused(500, 'unused')) });
  show();
  fireEvent.click(screen.getByRole('button', { name: /^Stop/ }));
  const said = await screen.findByRole('status');
  expect(said).toHaveTextContent(SENTENCE);
  expect(screen.queryByRole('alert')).toBeNull();
  await waitFor(() => expect(screen.getByRole('button', { name: /^Stop/ })).toBeDisabled());
  expect(screen.getByRole('button', { name: /^Stop/ })).toHaveTextContent('Finishing');
  expect(document.querySelector('.active-row')).not.toBeNull();
});

test('any other refusal of a Stop is still an alert', async () => {
  (engine as jest.Mock).mockReturnValue({ POST: jest.fn(() => refused(500, 'The engine broke.')), GET: jest.fn() });
  show();
  fireEvent.click(screen.getByRole('button', { name: /^Stop/ }));
  expect(await screen.findByRole('alert')).toHaveTextContent('The engine broke.');
});
