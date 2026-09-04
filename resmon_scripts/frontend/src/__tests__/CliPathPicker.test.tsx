/**
 * The Browse… button beside "Where is the `claude` command?" (1.8.7 D6).
 *
 * The real-browser half of this is `e2e/ai-settings.spec.ts` P5, which drives a
 * stubbed `dialog.showOpenDialog` in the real main process and watches the
 * field fill. This file covers the one arm a real Electron run cannot reach:
 * **there is no bridge**.
 *
 * That is not a hypothetical. `window.resmonAPI` is injected by the preload
 * script, so it exists in every packaged and every dev run — and does not exist
 * when the bundle is opened in an ordinary browser, which is how the renderer
 * is developed and how every jsdom test sees it. A button that quietly does
 * nothing there is the worst of the three outcomes, because the field it serves
 * is the one a user reaches for when something is already not working.
 */

import React from 'react';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import AISettings from '../components/Settings/AISettings';
import { mockRoutedFetch, renderWithProviders } from './testUtils';

const NOT_FOUND = {
  provider: 'claude_code', path: null, how: 'not-found',
  found: false, tried: ['/x/claude', 'PATH (claude)'], detail: 'Not found',
};

const AI_SETTINGS = {
  ai_provider: 'claude_code', ai_model: '', ai_local_model: '', ai_summary_length: '',
  ai_tone: '', ai_temperature: '', ai_extraction_goals: '',
  ai_custom_base_url: '', ai_custom_header_prefix: '', ai_default_models: '',
  ai_chain: '', ai_cli_path: '', ai_effort: '', ai_subscription_doc_cap: '',
};

async function renderPanel() {
  mockRoutedFetch({
    '/api/settings/ai': AI_SETTINGS,
    '/api/settings/ai/cli-status': { providers: [NOT_FOUND] },
    '/api/credentials': { keyring_responsive: true, credentials: {} },
  });
  await renderWithProviders(<AISettings />);
  // The disclosure opens by itself when the CLI was not found, which is the
  // only state in which this button is on screen at all.
  await waitFor(() => {
    expect(screen.getByLabelText('Primary command path')).toBeInTheDocument();
  });
}

describe('the command-path picker', () => {
  afterEach(() => {
    delete (window as { resmonAPI?: unknown }).resmonAPI;
  });

  test('fills the field with what the picker returned', async () => {
    (window as unknown as { resmonAPI: Record<string, unknown> }).resmonAPI = {
      getBackendPort: () => '1234',
      chooseFile: async () => '/Users/you/.local/bin/claude',
    };
    await renderPanel();
    fireEvent.click(screen.getByLabelText('Browse for the command'));
    await waitFor(() => {
      expect((screen.getByLabelText('Primary command path') as HTMLInputElement).value)
        .toBe('/Users/you/.local/bin/claude');
    });
  });

  test('leaves the field alone when the picker is cancelled', async () => {
    (window as unknown as { resmonAPI: Record<string, unknown> }).resmonAPI = {
      getBackendPort: () => '1234',
      chooseFile: async () => null,
    };
    await renderPanel();
    const field = () => screen.getByLabelText('Primary command path') as HTMLInputElement;
    fireEvent.change(field(), { target: { value: '/typed/by/hand' } });
    fireEvent.click(screen.getByLabelText('Browse for the command'));
    await waitFor(() => {
      expect(field().value).toBe('/typed/by/hand');
    });
    expect(screen.queryByTestId('cli-path-notice')).not.toBeInTheDocument();
  });

  test('says why when there is no desktop bridge, rather than doing nothing', async () => {
    // No `window.resmonAPI` at all — the browser build. The typed path still
    // works, and the message says that.
    await renderPanel();
    fireEvent.click(screen.getByLabelText('Browse for the command'));
    await waitFor(() => {
      expect(screen.getByTestId('cli-path-notice'))
        .toHaveTextContent(/only available inside the resmon desktop app/i);
    });
    expect((screen.getByLabelText('Primary command path') as HTMLInputElement).value).toBe('');
  });
});
