/** This Engine: the build it names, and the sentence that says only what the engine reports. */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { engine } from '../../../api/client';
import { Engine } from '../Engine';

jest.mock('../../../api/client', () => ({ ...jest.requireActual('../../../api/client'), engine: jest.fn() }));

const reply = (data: unknown) => Promise.resolve({ data, error: undefined, response: {} as Response });

function health(over: Record<string, unknown>) {
  return {
    status: 'ok', pid: 4242, started_at: '2026-11-05T10:00:00Z', version: '1.0.0',
    embeddings: { extension: null, reason: null },
    identity: { contract_version: 1, runtime_id: 'run-1', schema_version: 26, corpus_id: null, build_id: null },
    ...over,
  };
}

async function shown(over: Record<string, unknown>) {
  const GET = jest.fn((route: string) => reply(route === '/api/health' ? health(over) : { counts: { alarms: 0 } }));
  (engine as jest.Mock).mockReturnValue({ GET });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter><Engine /></MemoryRouter></QueryClientProvider>);
  await screen.findByText('Build');
  return document.querySelector('[data-health="identity"]')!;
}

test('the build the health answer names is shown when the identity has none', async () => {
  const section = await shown({ build: '1.0.0+checkout' });
  expect(section.querySelector('[data-health="build"]')!.textContent).toBe('1.0.0+checkout');
});

test('the identity\'s build id wins over the health answer\'s build', async () => {
  const section = await shown({ build: '1.0.0+checkout', identity: { ...health({}).identity, build_id: 'abc123' } });
  expect(section.querySelector('[data-health="build"]')!.textContent).toBe('abc123');
});

test('with no build named, the row says so', async () => {
  const section = await shown({ build: null });
  expect(section.querySelector('[data-health="build"]')!.textContent).toBe('not reported by this engine');
});

test('the closing sentence claims neither a build nor a collection the engine does not name', async () => {
  const section = await shown({ build: '1.0.0+checkout' });
  const hint = section.querySelector('.form-hint')!.textContent!.replace(/\s+/g, ' ');
  expect(hint).toBe('The runtime id is new each time an engine starts. The engine does not report which collection it is working in, so this screen names none.');
  expect(hint).not.toMatch(/which build/);
});
