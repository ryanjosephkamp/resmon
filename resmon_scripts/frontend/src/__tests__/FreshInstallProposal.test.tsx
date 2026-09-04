/**
 * P16 — the fresh-install proposal (1.8.5 D4.15).
 *
 * When nothing is configured and an agent CLI is sitting on the machine, the
 * AI settings page pre-selects it. That is a convenience with teeth: it is the
 * one thing in this phase that changes state without the user asking for it.
 *
 * The reconciliation removed its guard against overwriting a chosen provider
 * and all 160 renderer tests still passed — nothing anywhere exercised the
 * proposal. `D4.15` was in *Built* with no property and no guard.
 *
 * Four things have to hold, and the second is the one with consequences:
 *
 *   1. It fires on an empty configuration when a CLI was found.
 *   2. **It never overwrites a provider the user already chose**, whether that
 *      choice arrives as `ai_provider` or as a stored `ai_chain`. Overwriting
 *      would silently re-point someone's lane at a different model on a page
 *      they only opened to read.
 *   3. It fires once. A cli-status refresh must not re-propose over a provider
 *      the user cleared on purpose.
 *   4. It never sets `ai_enabled`. Proposing is selecting, not switching on —
 *      resmon cannot know whether the CLI is signed in until the first paper,
 *      and a page that enabled AI on sight would be promising that.
 *
 * jsdom, so this sees the DOM and not the layout: a proposal that fires
 * correctly but renders off-screen would pass. The real-browser half is
 * 1.8.7's P10.
 *
 * ONE THING THESE TESTS CANNOT SEPARATE, recorded because it would otherwise
 * look like a coverage gap. The overwrite guard has two layers — the
 * `if (settings.ai_provider) return;` early exit, and the
 * `prev.ai_provider ? prev : …` functional update. Removing **both** fails
 * `does not fire when a provider is already chosen`. Removing **either one
 * alone** fails nothing, because the other still holds in every scenario a
 * jsdom test can construct.
 *
 * They are not redundant in production. The early exit is the ordinary path.
 * The functional update guards a stale closure: the effect reads `settings`
 * from the render it was created in, so if the settings fetch resolves in the
 * same tick as cli-status, the early exit can see an empty provider that is
 * already stale by the time `setSettings` runs. Reproducing that race
 * deterministically here would mean controlling the resolution order of two
 * promises inside React's batching, which would test the harness rather than
 * the component. The property is guarded; which layer does it in a given tick
 * is not asserted.
 */

import React from 'react';
import { act, screen, waitFor } from '@testing-library/react';
import AISettings from '../components/Settings/AISettings';
import { mockRoutedFetch, renderWithProviders } from './testUtils';

const FOUND = {
  provider: 'claude_code', path: '/x/claude', how: 'known-location',
  found: true, tried: ['/x/claude'], detail: 'Found at /x/claude',
};
const NOT_FOUND = {
  provider: 'codex', path: null, how: 'none',
  found: false, tried: ['/y/codex'], detail: 'Not found',
};

/** Every route the panel touches on mount, with the AI settings overridable. */
function routes(ai: Record<string, string>, cli = [FOUND, NOT_FOUND]) {
  return {
    '/api/settings/ai': ai,
    '/api/settings/ai/cli-status': { providers: cli },
    '/api/credentials': { keyring_responsive: true, credentials: {} },
  };
}

const EMPTY_AI = {
  ai_provider: '', ai_model: '', ai_local_model: '', ai_summary_length: '',
  ai_tone: '', ai_temperature: '', ai_extraction_goals: '',
  ai_custom_base_url: '', ai_custom_header_prefix: '', ai_default_models: '',
  ai_chain: '', ai_cli_path: '', ai_effort: '', ai_subscription_doc_cap: '',
};

const providerSelect = () =>
  screen.getByRole('combobox', { name: 'Provider' }) as HTMLSelectElement;

async function renderPanel(ai: Record<string, string>, cli = [FOUND, NOT_FOUND]) {
  mockRoutedFetch(routes(ai, cli));
  await renderWithProviders(<AISettings />);
}

describe('the fresh-install proposal', () => {
  test('pre-selects a found CLI when nothing at all is configured', async () => {
    await renderPanel(EMPTY_AI);
    await waitFor(() => {
      expect(providerSelect().value).toBe('claude_code');
    });
  });

  test('says on screen that nothing has been switched on', async () => {
    await renderPanel(EMPTY_AI);
    await waitFor(() => {
      expect(screen.getByText(/Nothing is switched on yet/i)).toBeInTheDocument();
    });
  });

  test('does not fire when a provider is already chosen', async () => {
    // The guard the reconciliation removed. Overwriting here would re-point a
    // configured lane at a different model on a page the user only opened.
    await renderPanel({ ...EMPTY_AI, ai_provider: 'anthropic', ai_model: 'claude-3-5-sonnet' });
    await waitFor(() => {
      expect(providerSelect().value).toBe('anthropic');
    });
    expect(providerSelect().value).not.toBe('claude_code');
  });

  test('does not fire when a chain is stored, even with no legacy provider', async () => {
    // A user who built a chain has configured AI. `ai_provider` may be empty
    // while `ai_chain` holds the whole thing, so checking only the former
    // would propose over a real configuration.
    await renderPanel({
      ...EMPTY_AI,
      ai_chain: JSON.stringify([
        { kind: 'local', provider: 'local', model: 'llama3' },
      ]),
    });
    await waitFor(() => {
      expect(screen.getAllByRole('combobox').length).toBeGreaterThan(0);
    });
    expect(providerSelect().value).not.toBe('claude_code');
  });

  test('does not fire when no CLI was found', async () => {
    await renderPanel(EMPTY_AI, [{ ...NOT_FOUND, provider: 'claude_code' }, NOT_FOUND]);
    await waitFor(() => {
      expect(screen.getAllByRole('combobox').length).toBeGreaterThan(0);
    });
    expect(providerSelect().value).toBe('');
  });

  test('never sets ai_enabled, and never saves', async () => {
    const fetchMock = mockRoutedFetch(routes(EMPTY_AI));
    await renderWithProviders(<AISettings />);
    await waitFor(() => {
      expect(providerSelect().value).toBe('claude_code');
    });

    // Proposing is selecting a provider in the form and nothing else: no write
    // of any kind, so nothing can have been enabled or persisted.
    const writes = fetchMock.mock.calls.filter(
      ([, init]) => init && ['PUT', 'POST', 'DELETE'].includes(String((init as RequestInit).method)),
    );
    expect(writes).toHaveLength(0);
    const body = JSON.stringify(fetchMock.mock.calls);
    expect(body).not.toContain('ai_enabled');
  });

  test('fires once — a later cli-status refresh does not re-propose', async () => {
    await renderPanel(EMPTY_AI);
    await waitFor(() => {
      expect(providerSelect().value).toBe('claude_code');
    });

    // The user clears the provider on purpose, then something dispatches the
    // refresh event the panel listens for. The proposal must not undo them.
    await act(async () => {
      const select = providerSelect() as HTMLSelectElement;
      select.value = '';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => {
      window.dispatchEvent(new CustomEvent('ai-settings-changed'));
    });

    await waitFor(() => {
      expect(providerSelect().value).not.toBe('claude_code');
    });
  });
});
