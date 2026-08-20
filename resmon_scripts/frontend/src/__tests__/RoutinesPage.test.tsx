/**
 * Routines page — the table, the inline toggles, and the shape it took after
 * the cloud removal (no Source column, no Move to Cloud, no cloud rows).
 */

import React from 'react';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import RoutinesPage from '../pages/RoutinesPage';
import { callsTo, mockRoutedFetch, renderWithProviders } from './testUtils';

const ROUTINES = [
  {
    id: 1, name: 'Morning arXiv sweep', schedule_cron: '0 8 * * *',
    is_active: 1, email_enabled: 0, email_ai_summary_enabled: 0,
    ai_enabled: 1, notify_on_complete: 0,
    parameters: JSON.stringify({ keywords: ['diffusion'], repositories: ['arxiv'] }),
    last_execution: '2026-08-19T08:00:00', last_status: 'completed',
  },
  {
    id: 2, name: 'Weekly proteomics', schedule_cron: '0 9 * * 1',
    is_active: 0, email_enabled: 1, email_ai_summary_enabled: 0,
    ai_enabled: 0, notify_on_complete: 1,
    parameters: JSON.stringify({ keywords: ['proteomics'], repositories: ['biorxiv'] }),
  },
];

const CATALOG_ROUTES = {
  '/api/repositories/catalog': [],
  '/api/credentials': {},
};

describe('RoutinesPage', () => {
  test('renders one row per routine with schedule and status', async () => {
    mockRoutedFetch({ ...CATALOG_ROUTES, '/api/routines': ROUTINES });
    await renderWithProviders(<RoutinesPage />);

    expect(screen.getByText('Morning arXiv sweep')).toBeInTheDocument();
    expect(screen.getByText('Weekly proteomics')).toBeInTheDocument();
    expect(screen.getByText('0 8 * * *')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Inactive')).toBeInTheDocument();
  });

  test('no routines yet renders the empty message', async () => {
    mockRoutedFetch({ ...CATALOG_ROUTES, '/api/routines': [] });
    await renderWithProviders(<RoutinesPage />);
    expect(screen.getByText('No routines configured.')).toBeInTheDocument();
  });

  test('the cloud-era controls are gone', async () => {
    mockRoutedFetch({ ...CATALOG_ROUTES, '/api/routines': ROUTINES });
    await renderWithProviders(<RoutinesPage />);
    expect(screen.queryByText('Source')).not.toBeInTheDocument();
    expect(screen.queryByText('Move to Cloud')).not.toBeInTheDocument();
    expect(screen.queryByText('Move to Local')).not.toBeInTheDocument();
  });

  test('Deactivate posts to the routine lifecycle endpoint', async () => {
    const mock = mockRoutedFetch({
      ...CATALOG_ROUTES,
      '/api/routines': ROUTINES,
      '/api/routines/1/deactivate': {},
    });
    await renderWithProviders(<RoutinesPage />);

    fireEvent.click(screen.getByText('Deactivate'));
    await waitFor(() => {
      expect(callsTo(mock, '/api/routines/1/deactivate')).toHaveLength(1);
    });
  });

  test('an inline toggle PUTs just that flag', async () => {
    const mock = mockRoutedFetch({
      ...CATALOG_ROUTES,
      '/api/routines': ROUTINES,
      '/api/routines/1': {},
    });
    await renderWithProviders(<RoutinesPage />);

    // First routine's toggles render in column order: Email, AI, Notify.
    const toggles = document.querySelectorAll('tr .toggle-btn');
    expect(toggles.length).toBeGreaterThanOrEqual(3);
    fireEvent.click(toggles[0]);

    await waitFor(() => {
      const puts = callsTo(mock, '/api/routines/1').filter(
        (c) => (c.init?.method || 'GET').toUpperCase() === 'PUT',
      );
      expect(puts).toHaveLength(1);
      expect(JSON.parse(String(puts[0].init?.body))).toEqual({ email_enabled: true });
    });
  });
});
