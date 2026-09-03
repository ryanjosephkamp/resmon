/**
 * The subscription-lane controls (1.8.5 D5).
 *
 * Three properties, and the reason each is here rather than assumed:
 *
 * **The effort control exists only where effort exists.** None of the eight
 * BYOK providers takes a reasoning-effort parameter. Rendering the selector
 * for them would be a control that silently does nothing, which is the
 * overclaim this project rejects everywhere else.
 *
 * **The command path is not in the user's face.** It matters only when
 * detection failed, which is almost never — so it sits behind Advanced, and
 * Advanced opens by itself exactly when the CLI was not found.
 *
 * **A lane round-trips whole.** A saved lane that lost its effort or batch
 * size on load would run at the defaults while the form went on showing the
 * user's selection, which is worse than not offering the control.
 *
 * The real-browser-engine check for these surfaces is 1.8.7's; this is jsdom,
 * and it cannot see a control that renders but is invisible or unreachable.
 */

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import FallbackChain, {
  FallbackLane,
  CliStatus,
  SubscriptionCatalog,
} from '../components/Settings/FallbackChain';

const CATALOG: Record<string, SubscriptionCatalog> = {
  claude_code: {
    models: ['fable', 'opus', 'sonnet', 'haiku'],
    provenance: 'Aliases the claude command accepts — not a list of models this account can reach.',
    efforts: { opus: ['low', 'medium', 'high', 'xhigh', 'max'] },
    default_efforts: {},
    error: '',
  },
  codex: {
    models: ['gpt-5.6-sol', 'gpt-5.5'],
    provenance: 'Reported by `codex debug models` on this machine.',
    efforts: {
      'gpt-5.6-sol': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      'gpt-5.5': ['low', 'medium', 'high', 'xhigh'],
    },
    default_efforts: { 'gpt-5.6-sol': 'low' },
    error: '',
  },
};

const found: CliStatus = {
  provider: 'claude_code', path: '/x/claude', how: 'known-location',
  found: true, tried: ['/x/claude'], detail: 'Found at /x/claude',
};
const notFound: CliStatus = {
  provider: 'claude_code', path: null, how: 'none',
  found: false, tried: ['/x/claude'], detail: 'Not found',
};

function Harness({
  initial, cliStatus, onLoadCatalog,
}: {
  initial: FallbackLane[];
  cliStatus?: CliStatus[];
  onLoadCatalog?: (p: string, b?: string) => void;
}) {
  const [lanes, setLanes] = React.useState<FallbackLane[]>(initial);
  return (
    <>
      <FallbackChain
        lanes={lanes}
        onChange={setLanes}
        primaryLabel="anthropic · claude-3-5-sonnet"
        cliStatus={cliStatus}
        catalogs={CATALOG}
        onLoadCatalog={onLoadCatalog}
      />
      <pre data-testid="state">{JSON.stringify(lanes)}</pre>
    </>
  );
}

const state = () => JSON.parse(screen.getByTestId('state').textContent || '[]');
const subscription = (over: Partial<FallbackLane> = {}): FallbackLane => ({
  kind: 'subscription', provider: 'claude_code', model: '', ...over,
});

describe('the effort control is offered only where effort exists', () => {
  test('a subscription lane has one', () => {
    render(<Harness initial={[subscription()]} />);
    expect(screen.getByLabelText('Fallback 1 effort')).toBeInTheDocument();
  });

  test('an API-key lane does not', () => {
    render(<Harness initial={[{ kind: 'api_key', provider: 'anthropic', model: 'm' }]} />);
    expect(screen.queryByLabelText('Fallback 1 effort')).not.toBeInTheDocument();
  });

  test('an Ollama lane does not', () => {
    render(<Harness initial={[{ kind: 'local', provider: 'local', model: 'llama3' }]} />);
    expect(screen.queryByLabelText('Fallback 1 effort')).not.toBeInTheDocument();
  });

  test('the chosen level is stored on the lane', () => {
    render(<Harness initial={[subscription({ model: 'opus' })]} />);
    fireEvent.change(screen.getByLabelText('Fallback 1 effort'), { target: { value: 'xhigh' } });
    expect(state()[0].effort).toBe('xhigh');
  });

  test('codex offers the levels its own catalog reports for the chosen model', () => {
    render(<Harness initial={[subscription({ provider: 'codex', model: 'gpt-5.5' })]} />);
    const options = Array.from(
      screen.getByLabelText('Fallback 1 effort').querySelectorAll('option'),
    ).map((o) => (o as HTMLOptionElement).value);
    // gpt-5.5 stops at xhigh; gpt-5.6-sol goes to ultra. Offering `ultra` here
    // would be resmon inventing a level codex says this model does not take.
    expect(options).toEqual(['', 'low', 'medium', 'high', 'xhigh']);
  });
});

describe('the model dropdown', () => {
  test('offers the catalog for a subscription lane, with a CLI-default entry', () => {
    render(<Harness initial={[subscription()]} />);
    const options = Array.from(
      screen.getByLabelText('Fallback 1 model').querySelectorAll('option'),
    ).map((o) => (o as HTMLOptionElement).value);
    expect(options).toEqual(['', 'fable', 'opus', 'sonnet', 'haiku']);
  });

  test('keeps a saved model reachable even when the catalog does not list it', () => {
    render(<Harness initial={[subscription({ model: 'claude-fable-5' })]} />);
    expect(screen.getByText('claude-fable-5 (saved)')).toBeInTheDocument();
  });

  test('an API-key lane keeps free text', () => {
    render(<Harness initial={[{ kind: 'api_key', provider: 'anthropic', model: 'm' }]} />);
    expect(screen.getByLabelText('Fallback 1 model').tagName).toBe('INPUT');
  });

  test('loading the catalog is on demand and carries the configured path', () => {
    const onLoad = jest.fn();
    render(
      <Harness
        initial={[subscription({ binary_path: '/custom/claude' })]}
        onLoadCatalog={onLoad}
      />,
    );
    expect(onLoad).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText('Load claude_code models'));
    expect(onLoad).toHaveBeenCalledWith('claude_code', '/custom/claude');
  });
});

describe('the command path sits behind Advanced', () => {
  test('closed when the CLI was found', () => {
    render(<Harness initial={[subscription()]} cliStatus={[found]} />);
    const details = screen.getByText('Advanced').closest('details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
  });

  test('open when detection failed, which is exactly when it is the next step', () => {
    render(<Harness initial={[subscription()]} cliStatus={[notFound]} />);
    const details = screen.getByText('Advanced').closest('details') as HTMLDetailsElement;
    expect(details.open).toBe(true);
  });

  test('is labelled as a question rather than as a setting name', () => {
    render(<Harness initial={[subscription()]} cliStatus={[notFound]} />);
    expect(screen.getByText(/Where is the/)).toBeInTheDocument();
  });

  test('the path still reaches the lane', () => {
    render(<Harness initial={[subscription()]} cliStatus={[notFound]} />);
    fireEvent.change(screen.getByLabelText('Fallback 1 command path'), {
      target: { value: '/opt/claude' },
    });
    expect(state()[0].binary_path).toBe('/opt/claude');
  });
});

// ---------------------------------------------------------------------------
// The stored chain round trip
// ---------------------------------------------------------------------------

import { parseFallbacks } from '../components/Settings/AISettings';

describe('a subscription lane survives the chain round trip', () => {
  test('effort, batch size, cap and path all come back', () => {
    const stored = JSON.stringify([
      { kind: 'api_key', provider: 'anthropic', model: 'claude-3-5-sonnet' },
      {
        kind: 'subscription', provider: 'codex', model: 'gpt-5.6-sol',
        binary_path: '/opt/codex', doc_cap: 100, batch_size: 5, effort: 'high',
      },
    ]);
    const [lane] = parseFallbacks(stored);
    expect(lane).toMatchObject({
      kind: 'subscription',
      provider: 'codex',
      model: 'gpt-5.6-sol',
      binary_path: '/opt/codex',
      doc_cap: 100,
      batch_size: 5,
      effort: 'high',
    });
  });

  test('a lane that never set them comes back without inventing values', () => {
    const [lane] = parseFallbacks(JSON.stringify([
      { kind: 'api_key', provider: 'anthropic', model: 'm' },
      { kind: 'subscription', provider: 'claude_code', model: '' },
    ]));
    // undefined, not 0 or '' — the backend supplies the defaults, and a
    // renderer guess written into the chain would pin them forever.
    expect(lane.effort).toBeUndefined();
    expect(lane.batch_size).toBeUndefined();
  });
});
