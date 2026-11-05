/**
 * Reading the assistant's status again means a read that starts then. A read
 * already under way may have been answered from the settings as they stood
 * before a change, so it is cancelled and its answer dropped, even when it is
 * the window's first read and no answer is in hand yet.
 *
 * The engine is a double: each status read waits until the test answers it,
 * so the order the answers arrive in is the test's, not the event loop's.
 */
import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { engine } from '../../../api/client';
import { Ask } from '../Ask';
import type { Choices, Status } from '../askApi';
import { AskProvider, STATUS_KEY, useAsk } from '../AskProvider';

jest.mock('../../../api/client', () => ({ ...jest.requireActual('../../../api/client'), engine: jest.fn() }));

// jsdom has no `Response`; `answer` reads only `data` and `error` on success.
const reply = (data: unknown) => ({ data, error: undefined, response: {} as Response });

/** The engine's status, with Claude Code found or not. */
const status = (found: boolean): Status => ({
  composer_choices: {
    version: 1, default_error: null, claude_aliases: ['opus', 'sonnet'], claude_efforts: ['low', 'high'],
    limitations: 'Local prerequisites are not authentication.',
    default_request: { runtime: 'claude_cli', provider: 'claude_code', model: null, effort: null },
    connections: [
      { runtime: 'claude_cli', provider: 'claude_code', label: 'Claude Code', implemented: true, available: found,
        reason: found ? 'Claude Code command found.' : 'No claude command was found.', effort_supported: true },
    ],
  } as unknown as Choices,
} as unknown as Status);

let reads: ((answer: Status) => void)[];
let PUT: jest.Mock;

beforeEach(() => {
  reads = [];
  PUT = jest.fn(() => Promise.resolve(reply({})));
  (engine as jest.Mock).mockReturnValue({
    GET: jest.fn((route: string) => {
      if (route === '/api/assistant/status') return new Promise((resolve) => { reads.push((s) => resolve(reply(s))); });
      if (route === '/api/assistant/sessions/browse') return Promise.resolve(reply({ sessions: [], has_more: false, through_id: 0, next_before_id: null }));
      return new Promise(() => {}); // every other read is left unanswered
    }),
    PUT,
    POST: jest.fn(() => new Promise(() => {})),
  });
});
afterEach(() => { jest.resetAllMocks(); });

const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

/** The window: the assistant's state above the routes, and Ask arrived at only when `ask` is set. */
function Window({ client, children }: { client: QueryClient; children?: ReactNode }) {
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter><AskProvider>{children}</AskProvider></MemoryRouter>
    </QueryClientProvider>
  );
}

test('Ask, arrived at while the window’s first read is under way, reads again, and the earlier answer is not kept', async () => {
  const client = newClient();
  function Shell() {
    const [open, setOpen] = useState(false);
    return <>{open ? <Ask /> : <button type="button" onClick={() => setOpen(true)}>Ask</button>}</>;
  }
  render(<Window client={client}><Shell /></Window>);
  await waitFor(() => expect(reads).toHaveLength(1));

  // Ask is opened while that read is under way.
  fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
  await waitFor(() => expect(reads).toHaveLength(2));

  // The read begun on arrival answers first; the earlier one, from before the path, answers last.
  await act(async () => { reads[1]!(status(true)); });
  await act(async () => { reads[0]!(status(false)); });

  const composer = screen.getByLabelText('Message the assistant');
  await waitFor(() => expect(composer).toBeEnabled());
  expect(screen.getByRole('option', { name: 'Claude Code' })).toBeInTheDocument();
  expect(screen.queryByText('No claude command was found.')).toBeNull();
  expect(client.getQueryData<Status>(STATUS_KEY)?.composer_choices.connections[0]?.available).toBe(true);
});

test('New conversation, pressed while the window’s first read is under way, reads the defaults again', async () => {
  const client = newClient();
  const { result } = renderHook(() => useAsk(), { wrapper: ({ children }) => <Window client={client}>{children}</Window> });
  await waitFor(() => expect(reads).toHaveLength(1));

  act(() => result.current.select(null));
  await waitFor(() => expect(reads).toHaveLength(2));
  await act(async () => { reads[1]!(status(true)); });
  await act(async () => { reads[0]!(status(false)); });
  await waitFor(() => expect(result.current.status.data?.composer_choices.connections[0]?.available).toBe(true));
});
