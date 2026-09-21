/**
 * The renderer's half of duplicate protection.
 *
 * The backend's rule is that two requests carrying the same `request_id` are
 * one submission. Which makes the renderer's only job here a question of
 * *when* the id is made: one per click, so a double click is one search, and
 * never one per page, which would answer a user's genuine second search with
 * their first one's results. Both halves are asserted below, because a
 * constant id would pass a test that only checked the field was present.
 */

import React from 'react';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import DeepSweepPage from '../pages/DeepSweepPage';
import RoutinesPage from '../pages/RoutinesPage';
import { newRequestId } from '../api/requestId';
import { callsTo, mockRoutedFetch, renderWithProviders } from './testUtils';

const BASE_ROUTES = {
  '/api/repositories/catalog': [],
  '/api/credentials': {},
  '/api/search/repositories': ['arxiv'],
  '/api/search/sweep': { execution_id: 7 },
  '/api/configurations': [],
};

function bodiesOf(mock: jest.Mock, path: string): any[] {
  return callsTo(mock, path).map((c) => JSON.parse(String(c.init?.body ?? '{}')));
}

describe('request ids', () => {
  test('newRequestId never returns the same value twice', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i += 1) seen.add(newRequestId());
    expect(seen.size).toBe(100);
  });

  test('each Deep Sweep submission carries its own id', async () => {
    const fetchMock = mockRoutedFetch(BASE_ROUTES);
    await renderWithProviders(<DeepSweepPage />);

    const keywords = screen.getByPlaceholderText(/keyword/i);
    fireEvent.change(keywords, { target: { value: 'diffusion' } });
    fireEvent.keyDown(keywords, { key: 'Enter', code: 'Enter' });

    const repo = await screen.findByLabelText(/arxiv/i);
    fireEvent.click(repo);

    const run = screen.getByRole('button', { name: /Run Deep Sweep/i });
    fireEvent.click(run);
    await waitFor(() => expect(bodiesOf(fetchMock, '/api/search/sweep').length).toBe(1));
    fireEvent.click(run);
    await waitFor(() => expect(bodiesOf(fetchMock, '/api/search/sweep').length).toBe(2));

    const ids = bodiesOf(fetchMock, '/api/search/sweep').map((b) => b.request_id);
    expect(ids[0]).toBeTruthy();
    expect(ids[1]).toBeTruthy();
    expect(ids[0]).not.toBe(ids[1]);
  });
});

describe('missed fires on the Routines page', () => {
  const routine = (missed: any) => ([{
    id: 1, name: 'Morning arXiv sweep', schedule_cron: '0 8 * * *',
    is_active: 1, email_enabled: 0, email_ai_summary_enabled: 0,
    ai_enabled: 0, notify_on_complete: 0,
    parameters: JSON.stringify({ keywords: ['diffusion'], repositories: ['arxiv'] }),
    last_execution: '2026-09-15T08:00:00', last_status: 'completed',
    missed_fires: missed,
  }]);

  test('a routine that missed fires says how many and when the last was due', async () => {
    mockRoutedFetch({
      '/api/repositories/catalog': [], '/api/credentials': {},
      '/api/routines': routine({ count: 3, last_due_at_utc: '2026-09-19T07:00:00+00:00' }),
    });
    await renderWithProviders(<RoutinesPage />);
    expect(await screen.findByText(
      /missed 3 fires while resmon was closed; last due 2026-09-19T07:00:00\+00:00/,
    )).toBeInTheDocument();
  });

  test('a routine that missed none says nothing at all', async () => {
    mockRoutedFetch({
      '/api/repositories/catalog': [], '/api/credentials': {},
      '/api/routines': routine({ count: 0, last_due_at_utc: null }),
    });
    await renderWithProviders(<RoutinesPage />);
    await screen.findByText('Morning arXiv sweep');
    expect(screen.queryByText(/missed/i)).not.toBeInTheDocument();
  });
});
