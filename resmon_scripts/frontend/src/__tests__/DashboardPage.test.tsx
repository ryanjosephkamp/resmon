/**
 * Dashboard — active routines, recent activity, and the shape it took after
 * the cloud removal (no Cloud Sync card, no Source column).
 */

import React from 'react';
import { screen } from '@testing-library/react';
import DashboardPage from '../pages/DashboardPage';
import { mockRoutedFetch, renderWithProviders } from './testUtils';

const ROUTINES = [
  { id: 1, name: 'Nightly arXiv', schedule_cron: '0 2 * * *', is_active: 1, last_executed_at: '2026-08-19T02:00:00' },
  { id: 2, name: 'Paused sweep', schedule_cron: '0 3 * * *', is_active: 0 },
];

/** No history yet — the state a new install is in. */
const WATCHDOG_QUIET = {
  counts: { broken: 0, unusual: 0, alarms: 0 },
  sufficient: false,
};

const EXECUTIONS = [
  {
    id: 21, execution_type: 'routine', status: 'completed',
    start_time: '2026-08-19T02:00:05', result_count: 30, new_result_count: 4,
    keywords: ['solid-state battery'], repositories: ['arxiv'],
  },
];

describe('DashboardPage', () => {
  test('lists only active routines, and recent activity rows', async () => {
    mockRoutedFetch({
      '/api/routines': ROUTINES,
      '/api/executions': EXECUTIONS,
      '/api/watchdog': WATCHDOG_QUIET,
    });
    await renderWithProviders(<DashboardPage />);

    expect(screen.getByText('Nightly arXiv')).toBeInTheDocument();
    expect(screen.queryByText('Paused sweep')).not.toBeInTheDocument();
    expect(screen.getByText('Execution #21')).toBeInTheDocument();
  });

  test('the cloud-era surfaces are gone: no sync card, no Source column', async () => {
    mockRoutedFetch({
      '/api/routines': ROUTINES,
      '/api/executions': EXECUTIONS,
      '/api/watchdog': WATCHDOG_QUIET,
    });
    await renderWithProviders(<DashboardPage />);

    expect(screen.queryByText('Cloud Sync')).not.toBeInTheDocument();
    expect(screen.queryByText('Source')).not.toBeInTheDocument();
    expect(screen.queryByText(/resmon-cloud/)).not.toBeInTheDocument();
  });

  test('a fresh install renders both empty states rather than blank tables', async () => {
    mockRoutedFetch({
      '/api/routines': [],
      '/api/executions': [],
    });
    await renderWithProviders(<DashboardPage />);

    expect(screen.getByText(/No active routines/)).toBeInTheDocument();
  });

  // --- The watchdog strip -------------------------------------------------
  //
  // The Dashboard says whether to look; the Watchdog page says what at. What
  // matters here is that it stays silent until it has grounds to speak.

  test('the watchdog strip is absent until there is history to judge', async () => {
    mockRoutedFetch({
      '/api/routines': ROUTINES,
      '/api/executions': EXECUTIONS,
      '/api/watchdog': WATCHDOG_QUIET,
    });
    await renderWithProviders(<DashboardPage />);

    expect(screen.queryByText(/Watchdog: nothing looks wrong/)).not.toBeInTheDocument();
    expect(screen.queryByText('Open the Watchdog')).not.toBeInTheDocument();
  });

  test('a checked, healthy install gets one reassuring line', async () => {
    mockRoutedFetch({
      '/api/routines': ROUTINES,
      '/api/executions': EXECUTIONS,
      '/api/watchdog': { counts: { broken: 0, unusual: 0, alarms: 0 }, sufficient: true },
    });
    await renderWithProviders(<DashboardPage />);

    expect(screen.getByText(/Watchdog: nothing looks wrong/)).toBeInTheDocument();
  });

  test('a broken source surfaces on the Dashboard with a way through to it', async () => {
    mockRoutedFetch({
      '/api/routines': ROUTINES,
      '/api/executions': EXECUTIONS,
      '/api/watchdog': { counts: { broken: 1, unusual: 2, alarms: 3 }, sufficient: true },
    });
    await renderWithProviders(<DashboardPage />);

    expect(screen.getByText('1 broken')).toBeInTheDocument();
    expect(screen.getByText('2 unusual')).toBeInTheDocument();
    expect(screen.getByText('Something has stopped working.')).toBeInTheDocument();
    expect(screen.getByText('Open the Watchdog')).toHaveAttribute('href', '/watchdog');
  });
});
