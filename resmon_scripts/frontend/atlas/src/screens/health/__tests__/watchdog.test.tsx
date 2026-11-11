import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { engine } from '../../../api/client';
import type { components } from '../../../api/schema';
import type { WatchdogFinding, WatchdogReport } from '../model';
import { Watchdog } from '../Watchdog';

jest.mock('../../../api/client', () => ({ ...jest.requireActual('../../../api/client'), engine: jest.fn() }));

const reply = (data: unknown) => Promise.resolve({ data, error: undefined, response: {} as Response });

const findings: WatchdogFinding[] = [
  { key: 'source_errors:crossref', kind: 'source_errors', severity: 'broken', scope: { type: 'source', id: 'crossref' },
    title: 'Crossref failed on three runs', detail: 'Three failed answers remain on record.',
    what_to_do: 'Check the source.', evidence: {}, muted: false, muted_at: null },
  ...['arxiv', 'biorxiv'].map((id) => ({
    key: `source_partial:${id}`, kind: 'source_partial', severity: 'advice', scope: { type: 'source', id },
    title: `${id} answered in part`, detail: 'The read stopped at its budget.', what_to_do: 'Consider a smaller window.',
    evidence: {}, muted: false, muted_at: null,
  })),
];

const lifecycle: components['schemas']['LifecycleReport'] = {
  counts: { critical: 0, caution: 0, informational: 0 }, findings: [], sufficient: false,
  coverage: { corpus: 0, checked: 0, no_identifier: 0, errored: 0, unchecked: 0, last_checked_at: null, recheck_after_days: 30 },
  run: { running: false, stop_requested: false, started_at: null, error: null, last: null },
};

test('muting the final alarm keeps both advice findings and names the muted finding in the headline', async () => {
  let muted = false;
  const report = (): WatchdogReport => ({
    checked_at: '2026-10-29T08:00:00Z', sufficient: true, not_enough_data: [],
    findings: findings.map((f, index) => index === 0 ? { ...f, muted } : f),
    counts: { broken: muted ? 0 : 1, unusual: 0, advice: 2, muted: muted ? 1 : 0, alarms: muted ? 0 : 1 },
    watching: { sources: 3, routines: 1 },
    thresholds: { consecutive_errors: 3, consecutive_zeros: 4, min_baseline_runs: 5, flatline_runs: 5,
      overdue_cadence_multiple: 3, overdue_floor_days: 1, cadence_lag_multiple: 2, min_runs_for_cadence: 3,
      skipped_fires_window_days: 7 },
  });
  const GET = jest.fn((route: string) => {
    if (route === '/api/watchdog') return reply(report());
    if (route === '/api/repositories/catalog') return reply([]);
    if (route === '/api/lifecycle') return reply(lifecycle);
    throw new Error(`Unexpected route: ${route}`);
  });
  const POST = jest.fn((route: string) => {
    if (route !== '/api/watchdog/mute') throw new Error(`Unexpected mutation: ${route}`);
    muted = true;
    return reply({ ok: true });
  });
  (engine as jest.Mock).mockReturnValue({ GET, POST });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { container } = render(<QueryClientProvider client={client}><MemoryRouter><Watchdog /></MemoryRouter></QueryClientProvider>);
  const alarm = (await screen.findByRole('heading', { name: 'Crossref failed on three runs' })).closest('li')!;
  fireEvent.click(within(alarm).getByRole('button', { name: /^Mute$/ }));

  expect(await screen.findByRole('heading', { level: 1, name: '2 pieces of advice and 1 finding muted.' })).toBeInTheDocument();
  expect(container.querySelectorAll('.finding[data-severity="advice"][data-muted="false"]')).toHaveLength(2);
  expect(container.querySelector('[data-health="muted"]')).toHaveTextContent('Crossref failed on three runs');
  expect(container.querySelector('[data-health="watchdog-verdict"]')).not.toHaveTextContent('No source has failed');
  expect(container.querySelector('[data-health="alarms"]')).toBeNull();
});
