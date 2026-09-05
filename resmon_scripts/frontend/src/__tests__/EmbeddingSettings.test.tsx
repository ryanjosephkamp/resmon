/**
 * Settings → AI → Embeddings.
 *
 * What is worth guarding here is not the form — it is the honesty. Three
 * statements have to survive a refactor:
 *
 *   1. A provider that cannot embed is **listed and disabled with its reason**,
 *      not omitted. A gap explains nothing.
 *   2. The two facts that will surprise a paying user — an Anthropic key cannot
 *      embed, and neither agent CLI can — are on the page, not in a doc.
 *   3. Coverage and the extension state are reported **separately**, because
 *      they fail independently and the remedies differ.
 */

import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import EmbeddingSettings from '../components/Settings/EmbeddingSettings';

const PROVIDERS = [
  { provider: 'anthropic', state: 'no', offered: false, default_model: null,
    suggested_models: [],
    reason: 'Anthropic does not offer an embeddings API. An Anthropic key cannot embed, '
      + 'whatever it can do for summaries — pick a different provider.',
    evidence: '404 at /v1/embeddings while /v1/messages answered 401.' },
  { provider: 'claude_code', state: 'no', offered: false, default_model: null,
    suggested_models: [],
    reason: 'The Claude Code CLI cannot produce embeddings — it has no command for it.',
    evidence: 'no occurrence of embed in --help' },
  { provider: 'deepseek', state: 'unknown', offered: true, default_model: null,
    suggested_models: [],
    reason: 'resmon could not establish whether DeepSeek serves embeddings.',
    evidence: 'auth precedes routing' },
  { provider: 'local', state: 'yes', offered: true, default_model: 'nomic-embed-text',
    suggested_models: ['nomic-embed-text', 'all-minilm'],
    reason: 'Ollama serves embeddings, but only for a model that can embed.',
    evidence: 'live call returned 768 floats' },
];

const STATUS = {
  run: { running: false, model: null, processed: 0, total: 0, skipped_no_text: 0,
         cancelled: false, reason: null },
  coverage: { embedded: 120, total: 400, model: 'nomic-embed-text' },
  extension: { extension: 'v0.1.9', reason: null },
  index: { model: 'nomic-embed-text', dims: 768, rows: 120 },
};

function mockApi(overrides: Record<string, unknown> = {}) {
  const payload = {
    settings: {
      embedding_enabled: 'true',
      embedding_provider: 'local',
      embedding_model: 'nomic-embed-text',
      embedding_endpoint: 'http://localhost:11434',
      embedding_base_url: '',
    },
    providers: PROVIDERS,
    lane: { model: 'nomic-embed-text', kind: 'local' },
    capability: { available: true, extension: 'v0.1.9', reason: null,
                  model: 'nomic-embed-text', indexed: 120 },
    status: STATUS,
    ...overrides,
  };
  (global as any).fetch = jest.fn(async (url: string) => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => (String(url).includes('/api/embeddings/status')
      ? (payload as any).status
      : payload),
    text: async () => '',
  }));
  return payload;
}

async function renderPanel(overrides: Record<string, unknown> = {}) {
  mockApi(overrides);
  await act(async () => { render(<EmbeddingSettings />); });
}

test('the two facts that surprise a paying user are on the page', async () => {
  await renderPanel();
  const note = screen.getByTestId('embedding-cannot-note').textContent || '';
  expect(note).toContain('An Anthropic key cannot do this');
  expect(note).toContain('neither agent CLI can either');
});

test('a provider that cannot embed is listed and disabled, never omitted', async () => {
  await renderPanel();
  const select = screen.getByLabelText('Embedding provider') as HTMLSelectElement;
  const options = Array.from(select.options);
  // The denominator is the payload's own provider list: every one is offered as
  // an option, whatever its state.
  expect(options.map((o) => o.value).sort())
    .toEqual(PROVIDERS.map((p) => p.provider).sort());

  const anthropic = options.find((o) => o.value === 'anthropic')!;
  expect(anthropic.disabled).toBe(true);
  expect(anthropic.textContent).toContain('cannot embed');

  const unknown = options.find((o) => o.value === 'deepseek')!;
  expect(unknown.disabled).toBe(false);
  expect(unknown.textContent).toContain('unverified');
});

test('selecting a provider resmon could not verify explains that it declined to guess',
  async () => {
    await renderPanel();
    const select = screen.getByLabelText('Embedding provider');
    await act(async () => { fireEvent.change(select, { target: { value: 'deepseek' } }); });
    expect(screen.getByTestId('provider-reason').textContent)
      .toContain('could not establish');
  });

test('coverage names the model and the numbers', async () => {
  await renderPanel();
  const text = screen.getByTestId('embedding-coverage').textContent || '';
  expect(text).toContain('120');
  expect(text).toContain('400');
  expect(text).toContain('nomic-embed-text');
});

test('an extension that will not load is reported separately from the coverage', async () => {
  // The two fail independently: vectors with no extension means "this build
  // cannot rank"; an extension with no vectors means "run the backfill".
  await renderPanel({
    status: {
      ...STATUS,
      extension: { extension: null, reason: 'sqlite-vec did not load on this machine.' },
    },
  });
  const text = screen.getByTestId('embedding-extension').textContent || '';
  expect(text).toContain('cannot rank by meaning');
  expect(text).toContain('sqlite-vec did not load');
  // And it says the work is not wasted.
  expect(text).toContain('still');
});

test('a running backfill shows progress and offers a cooperative stop', async () => {
  await renderPanel({
    status: {
      ...STATUS,
      run: { running: true, model: 'nomic-embed-text', processed: 40, total: 280,
             skipped_no_text: 0, cancelled: false, reason: null },
    },
  });
  expect(screen.getByTestId('backfill-progress').textContent).toContain('40');
  expect(screen.getByText('Stop after this batch')).toBeTruthy();
  expect(screen.queryByTestId('backfill-button')).toBeNull();
});

test('a run that stopped early says why', async () => {
  await renderPanel({
    status: {
      ...STATUS,
      run: { running: false, model: 'gemma4:e2b', processed: 0, total: 280,
             skipped_no_text: 3, cancelled: false,
             reason: 'The server cannot produce embeddings with that model.' },
    },
  });
  const text = screen.getByTestId('backfill-outcome').textContent || '';
  expect(text).toContain('cannot produce embeddings');
  expect(text).toContain('3 paper(s) had no title or abstract');
});

test('the disk estimate is shown beside the cost, and says so for a free lane', async () => {
  // R2. Free to call is not free to store. The panel must not let a user infer
  // that a local model costs nothing at all.
  mockApi();
  (global as any).fetch = jest.fn(async (url: string) => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => {
      const u = String(url);
      if (u.includes('/api/embeddings/estimate')) {
        return {
          documents: 15707, estimated_tokens: 4704204, cost_usd: 0.0,
          disk_bytes: 140_599_296,
          disk_note: 'About 134 MiB of database growth (768-dimensional vectors, stored '
            + 'once in a plain table and once in the search index).',
          note: 'A local model runs on your machine and costs nothing to call.',
        };
      }
      if (u.includes('/api/embeddings/status')) return STATUS;
      return {
        settings: { embedding_enabled: 'true', embedding_provider: 'local',
                    embedding_model: 'nomic-embed-text', embedding_endpoint: '',
                    embedding_base_url: '' },
        providers: PROVIDERS, lane: { model: 'nomic-embed-text', kind: 'local' },
        capability: { available: true, extension: 'v0.1.9', reason: null,
                      model: 'nomic-embed-text', indexed: 120 },
        status: STATUS,
      };
    },
    text: async () => '',
  }));

  await act(async () => { render(<EmbeddingSettings />); });
  await act(async () => { fireEvent.click(screen.getByText('Estimate first')); });

  const disk = screen.getByTestId('embedding-disk-estimate').textContent || '';
  expect(disk).toContain('134 MiB');
  expect(disk).toContain('database growth');
  // And the money line still says the calls are free — the two are separate claims.
  expect(screen.getByTestId('embedding-estimate').textContent)
    .toContain('costs nothing to call');
});
