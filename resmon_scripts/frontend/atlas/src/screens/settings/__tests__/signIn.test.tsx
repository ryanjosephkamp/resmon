import type { ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { engine } from '../../../api/client';
import { CliSignIn } from '../CliSignIn';

jest.mock('../../../api/client', () => ({ ...jest.requireActual('../../../api/client'), engine: jest.fn() }));

// jsdom has no `Response`; `answer` reads only `data` and `error` on success.
const reply = (data: unknown) => Promise.resolve({ data, error: undefined, response: {} as Response });

const checked = (state: string, message: string) => ({
  provider: 'claude_code', state, message, email: null, plan: null, method: null, said: null,
  command: 'claude auth status --json', path: '/usr/local/bin/claude', checked_at_utc: '2026-10-30T15:45:00+00:00',
});

function mount(node: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

describe('signing in through the command’s own login', () => {
  let GET: jest.Mock;
  let POST: jest.Mock;
  beforeEach(() => {
    GET = jest.fn();
    POST = jest.fn();
    (engine as jest.Mock).mockReturnValue({ GET, POST });
  });
  afterEach(() => { jest.resetAllMocks(); });

  test('opened from Settings, it asks the command once and says what it said', async () => {
    GET.mockReturnValue(reply(checked('signed_in', 'The Claude Code command is signed in as r@example.com (max).')));
    mount(<CliSignIn provider="claude_code" purpose="ask" checkOnOpen />);
    expect(await screen.findByText('The Claude Code command is signed in as r@example.com (max).')).toBeInTheDocument();
    expect(GET).toHaveBeenCalledTimes(1);
    expect(GET).toHaveBeenCalledWith('/api/ai/cli/sign-in', { params: { query: { provider: 'claude_code', purpose: 'ask' } } });
    // Signed in: nothing to sign in to.
    expect(screen.queryByRole('button', { name: 'Sign In' })).toBeNull();
    expect(screen.getByRole('group', { name: 'Claude Code sign-in' })).toHaveAttribute('data-state', 'signed_in');
  });

  test('it tells the screen what the check answered, and nothing until it has', async () => {
    GET.mockReturnValue(reply(checked('signed_in', 'The Claude Code command is signed in as r@example.com (max).')));
    const onAnswer = jest.fn();
    const { unmount } = mount(<CliSignIn provider="claude_code" purpose="ask" checkOnOpen onAnswer={onAnswer} />);
    expect(onAnswer).toHaveBeenLastCalledWith(null);
    await waitFor(() => expect(onAnswer).toHaveBeenLastCalledWith('signed_in'));
    unmount();
    expect(onAnswer).toHaveBeenLastCalledWith(null);
  });

  test('under a failure it runs nothing until Check Again', async () => {
    GET.mockReturnValue(reply(checked('expired', 'The Claude Code command’s sign-in has expired. Sign in again through it.')));
    mount(<CliSignIn provider="claude_code" purpose="summaries" checkOnOpen={false} />);
    expect(screen.getByRole('button', { name: 'Sign In' })).toBeInTheDocument();
    expect(GET).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Check Again' }));
    expect(await screen.findByText(/sign-in has expired/)).toBeInTheDocument();
    expect(GET).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Check Again' }));
    await waitFor(() => expect(GET).toHaveBeenCalledTimes(2));
  });

  test('checked again, the last answer stays in place until the new one comes', async () => {
    const said = 'The Codex command did not say whether it is signed in. It said: env: node: No such file or directory';
    GET.mockReturnValueOnce(reply({ ...checked('failed', said), provider: 'codex' }));
    let settle: (value: unknown) => void = () => undefined;
    GET.mockReturnValueOnce(new Promise((resolve) => { settle = resolve; }));
    const onAnswer = jest.fn();
    mount(<CliSignIn provider="codex" purpose="ask" checkOnOpen onAnswer={onAnswer} />);
    expect(await screen.findByText(said)).toBeInTheDocument();
    onAnswer.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Check Again' }));
    expect(await screen.findByRole('button', { name: 'Checking…' })).toBeDisabled();
    // The words and the state the description reads are unchanged while the check runs.
    expect(screen.getByText(said)).toBeInTheDocument();
    expect(screen.queryByText(/Checking whether the Codex command/)).toBeNull();
    expect(onAnswer).not.toHaveBeenCalledWith(null);
    settle({ data: { ...checked('signed_in', 'The Codex command is signed in.'), provider: 'codex' }, error: undefined, response: {} });
    expect(await screen.findByText('The Codex command is signed in.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check Again' })).toBeEnabled();
  });

  test('Sign In opens the command’s login in Terminal, and says to come back', async () => {
    GET.mockReturnValue(reply(checked('signed_out', 'The Claude Code command on this computer is not signed in.')));
    POST.mockReturnValue(reply({
      provider: 'claude_code', opened: true, how: 'terminal', command: 'claude auth login', path: '/usr/local/bin/claude',
      message: 'Terminal is running Claude Code’s own sign-in. Finish it there, in the browser it opens, then choose Check Again.',
    }));
    mount(<CliSignIn provider="claude_code" purpose="ask" checkOnOpen />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign In' }));
    expect(await screen.findByText(/Terminal is running Claude Code’s own sign-in/)).toBeInTheDocument();
    expect(POST).toHaveBeenCalledWith('/api/ai/cli/sign-in', { body: { provider: 'claude_code', purpose: 'ask' } });
    expect(screen.getByText(/resmon does not see or keep the sign-in/)).toBeInTheDocument();
  });

  test('where nothing can be opened, the exact command is shown to copy', async () => {
    GET.mockReturnValue(reply(checked('signed_out', 'The Codex command on this computer is not signed in.')));
    POST.mockReturnValue(reply({
      provider: 'codex', opened: false, how: 'copy', command: "'/home/r/my bin/codex' login", path: '/home/r/my bin/codex',
      message: 'Run this in a terminal to sign in to Codex with its own login, then choose Check Again.',
    }));
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    mount(<CliSignIn provider="codex" purpose="summaries" binaryPath="/home/r/my bin/codex" checkOnOpen />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign In' }));
    expect(await screen.findByText("'/home/r/my bin/codex' login")).toBeInTheDocument();
    expect(POST).toHaveBeenCalledWith('/api/ai/cli/sign-in', {
      body: { provider: 'codex', purpose: 'summaries', binary_path: '/home/r/my bin/codex' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(await screen.findByText('Copied.')).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith("'/home/r/my bin/codex' login");
  });

  test('a command that is not found is not offered a sign-in', async () => {
    GET.mockReturnValue(reply(checked('missing', 'No claude executable was found.')));
    mount(<CliSignIn provider="claude_code" purpose="ask" checkOnOpen />);
    expect(await screen.findByText('No claude executable was found.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign In' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Check Again' })).toBeInTheDocument();
  });
});
