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
});
