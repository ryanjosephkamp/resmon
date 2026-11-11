import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { ask, type Choices, type Status } from '../askApi';
import { AskProvider, useAsk } from '../AskProvider';

/** The engine's status, with Settings › AI's saved default for a new conversation. */
const status = (model: string): Status => ({
  composer_choices: {
    version: 1, default_error: null, claude_aliases: ['opus', 'sonnet'], claude_efforts: ['low', 'high'],
    limitations: 'Local prerequisites are not authentication.',
    default_request: { runtime: 'claude_cli', provider: 'claude_code', model, effort: 'high' },
    connections: [
      { runtime: 'claude_cli', provider: 'claude_code', label: 'Claude Code', implemented: true, available: true,
        reason: 'Found.', effort_supported: true },
      { runtime: 'api_key', provider: 'custom', label: 'custom', implemented: true, available: true,
        reason: 'Key configured.', effort_supported: false, family: 'openai_chat' },
    ],
  } as unknown as Choices,
} as unknown as Status);

describe('New Conversation starts from Settings › AI’s saved defaults', () => {
  let saved: Status;
  beforeEach(() => {
    saved = status('opus');
    jest.spyOn(ask, 'status').mockImplementation(async () => saved);
  });
  afterEach(() => { jest.restoreAllMocks(); });

  function open() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}><AskProvider>{children}</AskProvider></QueryClientProvider>
    );
    return renderHook(() => useAsk(), { wrapper });
  }

  test('pressed on an unsent new conversation, it drops the choice made for it and reads the defaults again', async () => {
    const { result } = open();
    await waitFor(() => expect(result.current.draft?.model).toBe('opus'));

    // A choice made for the unsent conversation, then Settings › AI changes its default.
    act(() => result.current.setDraft({ version: 1, runtime: 'api_key', provider: 'custom', model: 'gpt-x', effort: null }));
    saved = status('sonnet');
    expect(result.current.selected).toBeNull();

    act(() => result.current.select(null));
    await waitFor(() => expect(result.current.draft).toEqual({
      version: 1, runtime: 'claude_cli', provider: 'claude_code', model: 'sonnet', effort: 'high',
    }));
    expect(result.current.selected).toBeNull();

    // From then on the draft follows the defaults again, until a choice is made here.
    saved = status('haiku');
    act(() => result.current.select(null));
    await waitFor(() => expect(result.current.draft?.model).toBe('haiku'));
  });

  test('opening a saved conversation leaves the choice made for the next new one alone', async () => {
    const { result } = open();
    await waitFor(() => expect(result.current.draft?.model).toBe('opus'));
    const mine = { version: 1 as const, runtime: 'api_key' as const, provider: 'custom', model: 'gpt-x', effort: null };
    act(() => result.current.setDraft(mine));
    act(() => result.current.select(12));
    expect(result.current.selected).toBe(12);
    expect(result.current.draft).toEqual(mine);
  });
});

describe('a paper question while an earlier conversation is being created', () => {
  afterEach(() => jest.restoreAllMocks());
  test('the earlier session is kept without replacing the newly opened paper draft', async () => {
    jest.spyOn(ask, 'status').mockResolvedValue(status('opus'));
    let finish: (session: Awaited<ReturnType<typeof ask.create>>) => void = () => undefined;
    const create = jest.spyOn(ask, 'create').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const turn = jest.spyOn(ask, 'turn').mockResolvedValue();
    jest.spyOn(ask, 'detail').mockResolvedValue({} as Awaited<ReturnType<typeof ask.detail>>);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useAsk(), { wrapper: ({ children }) => <QueryClientProvider client={client}><AskProvider>{children}</AskProvider></QueryClientProvider> });
    await waitFor(() => expect(result.current.draft?.model).toBe('opus'));
    act(() => result.current.preparePaper({ title: 'First paper', paperId: 1 }));
    act(() => { void result.current.send('Read paper 1.'); });
    await waitFor(() => expect(create).toHaveBeenCalled());
    act(() => result.current.preparePaper({ title: 'Second paper', paperId: 2 }));
    await act(async () => finish({ id: 31 } as Awaited<ReturnType<typeof ask.create>>));
    await waitFor(() => expect(result.current.answering).toBe(false));
    expect(turn.mock.calls[0]?.[0]).toBe(31);
    expect(result.current.selected).toBeNull();
    expect(result.current.paper?.title).toBe('Second paper');
    expect(result.current.paperText).toContain('paper 2');
  });
});
