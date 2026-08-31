/**
 * The subscription lane in the chain editor (1.8c).
 *
 * What matters here is not that a new option appears in a dropdown. It is that
 * the user is told, before the run rather than after it, that this lane spends
 * the Claude Max or ChatGPT window they use for their own work — and that the
 * per-run paper limit is visible and editable rather than an invisible backend
 * default. A guard nobody can see is a guard nobody trusts.
 */

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import FallbackChain, {
  CliStatus,
  FallbackLane,
} from '../components/Settings/FallbackChain';

function Harness({
  initial = [] as FallbackLane[],
  cliStatus,
}: {
  initial?: FallbackLane[];
  cliStatus?: CliStatus[];
}) {
  const [lanes, setLanes] = React.useState<FallbackLane[]>(initial);
  return (
    <>
      <FallbackChain
        lanes={lanes}
        onChange={setLanes}
        primaryLabel="anthropic · claude-3-5-sonnet"
        cliStatus={cliStatus}
      />
      <pre data-testid="state">{JSON.stringify(lanes)}</pre>
    </>
  );
}

const state = () => JSON.parse(screen.getByTestId('state').textContent || '[]');

const subscriptionLane = (over: Partial<FallbackLane> = {}): FallbackLane => ({
  kind: 'subscription',
  provider: 'claude_code',
  model: '',
  doc_cap: 25,
  ...over,
});

describe('the subscription lane', () => {
  test('both agent CLIs are offered as lanes', () => {
    render(<Harness initial={[subscriptionLane()]} />);
    const select = screen.getByLabelText(/fallback 1 provider/i);
    const values = Array.from(select.querySelectorAll('option')).map(
      (o) => (o as HTMLOptionElement).value,
    );
    expect(values).toEqual(expect.arrayContaining(['claude_code', 'codex']));
  });

  test('choosing one seeds the document cap so the guard is visible', () => {
    render(<Harness initial={[{ kind: 'local', provider: 'local', model: '' }]} />);
    fireEvent.change(screen.getByLabelText(/fallback 1 provider/i), {
      target: { value: 'codex' },
    });
    expect(state()[0]).toMatchObject({
      kind: 'subscription',
      provider: 'codex',
      doc_cap: 25,
    });
  });

  test('switching away from a subscription lane clears the cap', () => {
    render(<Harness initial={[subscriptionLane()]} />);
    fireEvent.change(screen.getByLabelText(/fallback 1 provider/i), {
      target: { value: 'anthropic' },
    });
    expect(state()[0].kind).toBe('api_key');
    expect(state()[0].doc_cap).toBeUndefined();
  });

  test('the cap is editable and what is typed is what is stored', () => {
    render(<Harness initial={[subscriptionLane()]} />);
    fireEvent.change(screen.getByLabelText(/fallback 1 document limit/i), {
      target: { value: '5' },
    });
    expect(state()[0].doc_cap).toBe(5);
  });

  test('warns that the run spends the user own plan, and names the limit', () => {
    render(<Harness initial={[subscriptionLane({ doc_cap: 12 })]} />);
    expect(screen.getByText(/spends your own plan/i)).toBeInTheDocument();
    expect(screen.getByText(/at most 12 papers/i)).toBeInTheDocument();
    expect(screen.getByText(/usage window you use for your own work/i)).toBeInTheDocument();
  });

  test('names the right plan for each provider', () => {
    const { unmount } = render(<Harness initial={[subscriptionLane()]} />);
    expect(screen.getByText(/Claude usage\s+window/i)).toBeInTheDocument();
    unmount();

    render(<Harness initial={[subscriptionLane({ provider: 'codex' })]} />);
    expect(screen.getByText(/ChatGPT usage\s+window/i)).toBeInTheDocument();
  });

  test('says resmon never sees the sign-in', () => {
    render(<Harness initial={[subscriptionLane()]} />);
    expect(screen.getByText(/never sees or\s+stores your sign-in/i)).toBeInTheDocument();
  });

  test('a subscription lane offers a command-path field', () => {
    render(<Harness initial={[subscriptionLane()]} />);
    fireEvent.change(screen.getByLabelText(/fallback 1 command path/i), {
      target: { value: '/opt/claude' },
    });
    expect(state()[0].binary_path).toBe('/opt/claude');
  });

  test('an API-key lane offers no command path or cap', () => {
    render(
      <Harness initial={[{ kind: 'api_key', provider: 'anthropic', model: 'm' }]} />,
    );
    expect(screen.queryByLabelText(/command path/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/document limit/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/spends your own plan/i)).not.toBeInTheDocument();
  });
});

describe('CLI detection status', () => {
  const found: CliStatus = {
    provider: 'claude_code',
    path: '/Users/x/.local/bin/claude',
    how: 'known-location',
    found: true,
    tried: ['/Users/x/.local/bin/claude'],
    detail: 'Found where the installer puts it: /Users/x/.local/bin/claude',
  };

  const missing: CliStatus = {
    provider: 'codex',
    path: null,
    how: 'not-found',
    found: false,
    tried: ['/Applications/ChatGPT.app/Contents/Resources/codex', 'PATH (codex)'],
    detail: 'No codex executable was found. Set its full path in Settings if it is installed somewhere this list does not cover.',
  };

  test('shows where a found CLI was found', () => {
    render(<Harness initial={[subscriptionLane()]} cliStatus={[found]} />);
    const line = screen.getByTestId('cli-status-claude_code');
    expect(line).toHaveTextContent('Found where the installer puts it');
    expect(line).toHaveTextContent('✓');
  });

  test('a missing CLI lists the paths that were searched', () => {
    render(
      <Harness
        initial={[subscriptionLane({ provider: 'codex' })]}
        cliStatus={[missing]}
      />,
    );
    const line = screen.getByTestId('cli-status-codex');
    expect(line).toHaveTextContent('ChatGPT.app');
    expect(line).toHaveTextContent('PATH (codex)');
  });

  test('never claims the user is signed in, because detection cannot know', () => {
    render(<Harness initial={[subscriptionLane()]} cliStatus={[found]} />);
    const line = screen.getByTestId('cli-status-claude_code');
    expect(line).toHaveTextContent(/has not checked whether you are signed in/i);
  });

  test('omits the status line entirely when detection has not loaded', () => {
    render(<Harness initial={[subscriptionLane()]} />);
    expect(screen.queryByTestId('cli-status-claude_code')).not.toBeInTheDocument();
  });
});
