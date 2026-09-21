import React from 'react';
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '@testing-library/jest-dom';
import FirstRunCard, { STEP_DESTINATIONS } from '../components/Onboarding/FirstRunCard';
import { allRouteHashes } from '../routes';

/**
 * P15b and P15c's renderer halves.
 *
 * The condition itself — *when* the card shows — is the backend's and is tested
 * there against a real database. What is checked here is what the card does
 * with the answer: that every destination is a route the app actually serves,
 * that it renders three states rather than two, and that it does not turn the
 * backend's careful "found" into "ready".
 */

const FRESH = {
  show: true,
  dismissed: false,
  counts: { documents: 0, executions: 0, routines: 0 },
  steps: [
    { id: 'agent_cli', done: true, detail: 'resmon found Claude Code on this machine.' },
    { id: 'ai_key', done: false, detail: 'No AI provider is configured.' },
    { id: 'repository_key', done: null, detail: '5 of resmon’s sources can take a key of their own. The rest need none.' },
  ],
};

/**
 * `gates` holds one path's response open (or rejects it), so a test can observe
 * the card mid-request rather than only after it. A gate that rejects stands in
 * for a backend that refused the write.
 */
function mockBackend(state: unknown, gates: Record<string, Promise<void>> = {}) {
  const calls: string[] = [];
  // Mark every gate handled up front: an unawaited rejection between mounting
  // and the click is an unhandled-rejection warning, not a test failure.
  Object.values(gates).forEach((gate) => { void gate.catch(() => {}); });
  (global as any).fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, '');
    calls.push(`${init?.method || 'GET'} ${path}`);
    const gate: Promise<void> | undefined = gates[path];
    if (gate !== undefined) await gate;
    const payload = path === '/api/onboarding' ? state : { dismissed: true };
    return {
      ok: true, status: 200,
      headers: { get: () => 'application/json' },
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    } as any;
  });
  return calls;
}

async function mount() {
  await act(async () => {
    render(<MemoryRouter><FirstRunCard /></MemoryRouter>);
  });
}

beforeEach(() => { jest.restoreAllMocks(); });

describe('the first-run card', () => {
  it('renders one row per step, with the destination each one names', async () => {
    mockBackend(FRESH);
    await mount();
    await waitFor(() => expect(screen.getByTestId('first-run-card')).toBeInTheDocument());
    for (const step of FRESH.steps) {
      expect(screen.getByTestId(`first-run-step-${step.id}`)).toHaveTextContent(step.detail);
    }
  });

  it('sends every step to a route the app actually serves', () => {
    /* P15b, against `routes.ts` — the one route table, not a copy. A dead link
       on the first screen a new user sees is the worst place for one. */
    const served = new Set(allRouteHashes().map((r) => r.hash));
    for (const [id, destination] of Object.entries(STEP_DESTINATIONS)) {
      expect(served.has(destination.to)).toBe(true);
      expect(id).toBeTruthy();
    }
  });

  it('distinguishes "not done" from "could not check"', async () => {
    /* Three states, because an unreadable keyring is not a missing key. */
    mockBackend(FRESH);
    await mount();
    await waitFor(() => expect(screen.getByTestId('first-run-card')).toBeInTheDocument());
    expect(screen.getByLabelText('done')).toBeInTheDocument();
    expect(screen.getByLabelText('not done')).toBeInTheDocument();
    expect(screen.getByLabelText('could not check')).toBeInTheDocument();
  });

  it('says the list is optional and that found is not working', async () => {
    /* P15c. The card is the first thing a new user reads; a checklist that
       reads as prerequisites makes resmon look like it needs an AI to search. */
    mockBackend(FRESH);
    await mount();
    await waitFor(() => expect(screen.getByTestId('first-run-card')).toBeInTheDocument());
    const text = screen.getByTestId('first-run-card').textContent || '';
    expect(text).toMatch(/optional/i);
    expect(text).toMatch(/not the same as working/i);
    for (const word of ['ready to use', 'you are all set', 'connected and working']) {
      expect(text.toLowerCase()).not.toContain(word);
    }
  });

  it('does not render at all when the backend says not to', async () => {
    mockBackend({ ...FRESH, show: false });
    await mount();
    expect(screen.queryByTestId('first-run-card')).not.toBeInTheDocument();
  });

  it('does not render when the backend cannot answer', async () => {
    /* The least important thing on the Dashboard must never be the reason the
       Dashboard shows an error. */
    (global as any).fetch = jest.fn(async () => { throw new Error('backend down'); });
    await mount();
    expect(screen.queryByTestId('first-run-card')).not.toBeInTheDocument();
  });

  it('tells the backend to keep it that way, and only then goes', async () => {
    /* The card used to hide the instant Skip was pressed and let the POST fly
       unawaited, so a reload that beat the write to the database brought it
       back — a one-in-two flake on the xvfb e2e job. Holding the response open
       here is what distinguishes "waited" from "happened to be fast": while the
       request is in flight the card must still be on screen and the button
       disabled, and only the resolution may hide it. */
    let releaseDismiss: () => void = () => {};
    const held = new Promise<void>((resolve) => { releaseDismiss = resolve; });
    const calls = mockBackend(FRESH, { '/api/onboarding/dismiss': held });

    await mount();
    await waitFor(() => expect(screen.getByTestId('first-run-card')).toBeInTheDocument());

    await act(async () => { fireEvent.click(screen.getByTestId('first-run-skip')); });
    expect(calls).toContain('POST /api/onboarding/dismiss');
    expect(screen.getByTestId('first-run-card')).toBeInTheDocument();
    expect(screen.getByTestId('first-run-skip')).toBeDisabled();

    await act(async () => { releaseDismiss(); await held; });
    await waitFor(() => expect(screen.queryByTestId('first-run-card')).not.toBeInTheDocument());
  });

  it('keeps the card, and says so, when the dismissal is refused', async () => {
    /* P2. Boundary: jsdom with a stubbed fetch — a hermetic double, not the
       real backend. It establishes what the component does with a rejection,
       not that this backend ever rejects. */
    mockBackend(FRESH, { '/api/onboarding/dismiss': Promise.reject(new Error('http 500')) });
    await mount();
    await waitFor(() => expect(screen.getByTestId('first-run-card')).toBeInTheDocument());

    await act(async () => { fireEvent.click(screen.getByTestId('first-run-skip')); });

    await waitFor(() => expect(screen.getByTestId('first-run-dismiss-error')).toBeInTheDocument());
    expect(screen.getByTestId('first-run-card')).toBeInTheDocument();
    expect(screen.getByTestId('first-run-skip')).not.toBeDisabled();
  });
});
