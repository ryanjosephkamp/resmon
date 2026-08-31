/**
 * The fallback-chain editor (1.8b).
 *
 * The behaviour worth pinning is not that buttons render — it is that the
 * chain saved to the backend is the *complete* ordered chain with the primary
 * provider at lane 0, and that leaving the section alone stores nothing at all
 * so a user who never opens it keeps behaving exactly as before.
 */

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import FallbackChain, { FallbackLane } from '../components/Settings/FallbackChain';

function Harness({ initial = [] as FallbackLane[], primaryLabel = 'anthropic · claude-3-5-sonnet' }) {
  const [lanes, setLanes] = React.useState<FallbackLane[]>(initial);
  return (
    <>
      <FallbackChain lanes={lanes} onChange={setLanes} primaryLabel={primaryLabel} />
      <pre data-testid="state">{JSON.stringify(lanes)}</pre>
    </>
  );
}

const state = () => JSON.parse(screen.getByTestId('state').textContent || '[]');

describe('FallbackChain', () => {
  test('shows the primary provider as the head of the chain', () => {
    render(<Harness />);
    expect(screen.getByText('anthropic · claude-3-5-sonnet')).toBeInTheDocument();
    expect(screen.getByText(/tried first/i)).toBeInTheDocument();
  });

  test('says plainly that an empty chain is the old behaviour', () => {
    render(<Harness />);
    expect(
      screen.getByText(/exactly how\s+resmon behaved before fallbacks existed/i),
    ).toBeInTheDocument();
  });

  test('adding a fallback defaults to the local lane, which needs no key', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: /add a fallback/i }));
    expect(state()).toEqual([{ kind: 'local', provider: 'local', model: '' }]);
  });

  test('switching a fallback to a keyed provider updates its kind', async () => {
    render(<Harness initial={[{ kind: 'local', provider: 'local', model: '' }]} />);
    fireEvent.change(screen.getByLabelText(/fallback 1 provider/i), {
      target: { value: 'openai' },
    });
    await waitFor(() => expect(state()[0]).toMatchObject({ provider: 'openai', kind: 'api_key' }));
  });

  test('a local fallback exposes an endpoint field and a keyed one does not', () => {
    // Two separate mounts rather than a rerender: Harness seeds useState from
    // `initial`, which React only reads on first mount, so a rerender would
    // silently keep the old lane and the assertion would prove nothing.
    const local = render(
      <Harness initial={[{ kind: 'local', provider: 'local', model: 'llama3' }]} />,
    );
    expect(screen.getByLabelText(/fallback 1 endpoint/i)).toBeInTheDocument();
    local.unmount();

    render(<Harness initial={[{ kind: 'api_key', provider: 'openai', model: 'gpt-4o-mini' }]} />);
    expect(screen.queryByLabelText(/fallback 1 endpoint/i)).not.toBeInTheDocument();
  });

  test('a keyed fallback says a missing key skips the lane rather than failing the run', () => {
    render(<Harness initial={[{ kind: 'api_key', provider: 'openai', model: 'gpt-4o-mini' }]} />);
    expect(screen.getByText(/records that this lane was skipped/i)).toBeInTheDocument();
  });

  test('order can be changed, because order is the whole feature', () => {
    render(
      <Harness
        initial={[
          { kind: 'api_key', provider: 'openai', model: 'a' },
          { kind: 'local', provider: 'local', model: 'b' },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /move fallback 2 up/i }));
    expect(state().map((l: FallbackLane) => l.provider)).toEqual(['local', 'openai']);
  });

  test('the ends of the list cannot be moved past', () => {
    render(
      <Harness
        initial={[
          { kind: 'api_key', provider: 'openai', model: 'a' },
          { kind: 'local', provider: 'local', model: 'b' },
        ]}
      />,
    );
    expect(screen.getByRole('button', { name: /move fallback 1 up/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /move fallback 2 down/i })).toBeDisabled();
  });

  test('a fallback can be removed', () => {
    render(<Harness initial={[{ kind: 'local', provider: 'local', model: 'llama3' }]} />);
    fireEvent.click(screen.getByRole('button', { name: /remove fallback 1/i }));
    expect(state()).toEqual([]);
  });

  test('no provider selected is stated rather than left blank', () => {
    render(<Harness primaryLabel="" />);
    expect(screen.getByText(/no provider selected/i)).toBeInTheDocument();
  });
});
