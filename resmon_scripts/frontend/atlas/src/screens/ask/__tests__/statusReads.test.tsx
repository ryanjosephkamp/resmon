/**
 * Reading the assistant's status again means a read that starts then. A read
 * already under way may have been answered from the settings as they stood
 * before a change, so it is canceled and its answer dropped, even when it is
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
import type { AiSettings } from '../../settings/summaryLanes';
import { SummaryForm } from '../../settings/SummaryForm';
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

  const composer = screen.getByLabelText('Message the Assistant');
  await waitFor(() => expect(composer).toBeEnabled());
  expect(screen.getByRole('option', { name: 'Claude Code' })).toBeInTheDocument();
  expect(screen.queryByText('No claude command was found.')).toBeNull();
  expect(client.getQueryData<Status>(STATUS_KEY)?.composer_choices.connections[0]?.available).toBe(true);
});

test('New Conversation, pressed while the window’s first read is under way, reads the defaults again', async () => {
  const client = newClient();
  const { result } = renderHook(() => useAsk(), { wrapper: ({ children }) => <Window client={client}>{children}</Window> });
  await waitFor(() => expect(reads).toHaveLength(1));

  act(() => result.current.select(null));
  await waitFor(() => expect(reads).toHaveLength(2));
  await act(async () => { reads[1]!(status(true)); });
  await act(async () => { reads[0]!(status(false)); });
  await waitFor(() => expect(result.current.status.data?.composer_choices.connections[0]?.available).toBe(true));
});

test('a command path saved in Settings › AI while the window’s first read is under way is in the status read after it', async () => {
  const client = newClient();
  // Every setting blank, except that summaries use Claude Code.
  const blank = ['ai_chain', 'ai_cli_path', 'ai_custom_base_url', 'ai_custom_header_prefix', 'ai_default_models', 'ai_effort',
    'ai_extraction_goals', 'ai_local_endpoint', 'ai_local_model', 'ai_model', 'ai_show_audit_prefix', 'ai_subscription_doc_cap',
    'ai_summary_length', 'ai_temperature', 'ai_tone'];
  const stored = { ...Object.fromEntries(blank.map((key) => [key, ''])), ai_provider: 'claude_code' } as unknown as AiSettings;
  render(<Window client={client}><SummaryForm stored={stored} /></Window>);
  await waitFor(() => expect(reads).toHaveLength(1));

  fireEvent.change(screen.getByLabelText('Command'), { target: { value: '/opt/tools/claude' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save Summary Settings' }));
  await waitFor(() => expect(PUT).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(reads).toHaveLength(2));

  await act(async () => { reads[1]!(status(true)); });
  await act(async () => { reads[0]!(status(false)); });
  await waitFor(() => expect(client.getQueryData<Status>(STATUS_KEY)?.composer_choices.connections[0]?.available).toBe(true));
  expect(await screen.findByRole('button', { name: 'Save Summary Settings' })).toBeInTheDocument();
});
