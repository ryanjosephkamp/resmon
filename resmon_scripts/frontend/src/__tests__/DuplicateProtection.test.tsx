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

async function fillSweepForm(): Promise<void> {
  const keywords = screen.getByPlaceholderText(/keyword/i);
  fireEvent.change(keywords, { target: { value: 'diffusion' } });
  fireEvent.keyDown(keywords, { key: 'Enter', code: 'Enter' });
  const repo = await screen.findByLabelText(/arxiv/i);
  fireEvent.click(repo);
}

function bodiesOf(mock: jest.Mock, path: string): any[] {
  return callsTo(mock, path).map((c) => JSON.parse(String(c.init?.body ?? '{}')));
}

describe('request ids', () => {
  test('newRequestId never returns the same value twice', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i += 1) seen.add(newRequestId());
    expect(seen.size).toBe(100);
  });

  test('the submit control is disabled while a sweep request is in flight', async () => {
    // The claim "a double click yields one run" is about this, not about the
    // id: two clicks would otherwise be two submissions with two ids and two
    // runs. Never resolving the request holds the in-flight state open.
    const fetchMock = mockRoutedFetch({
      ...BASE_ROUTES,
      '/api/search/sweep': () => new Promise(() => {}),
    });
    await renderWithProviders(<DeepSweepPage />);
    await fillSweepForm();

    const run = screen.getByRole('button', { name: /Run Deep Sweep/i });
    fireEvent.click(run);

    const starting = await screen.findByRole('button', { name: /Starting/i });
    expect(starting).toBeDisabled();
    fireEvent.click(starting);
    fireEvent.click(starting);
    expect(callsTo(fetchMock, '/api/search/sweep').length).toBe(1);
  });

  test('each Deep Sweep submission carries its own id', async () => {
    const fetchMock = mockRoutedFetch(BASE_ROUTES);
    await renderWithProviders(<DeepSweepPage />);

    await fillSweepForm();

    const run = screen.getByRole('button', { name: /Run Deep Sweep/i });
    fireEvent.click(run);
    await waitFor(() => expect(bodiesOf(fetchMock, '/api/search/sweep').length).toBe(1));
    // A user's genuine second search: the control comes back once the first
    // request has settled, and the run it starts is a new submission.
    await waitFor(() => expect(run).not.toBeDisabled());
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
      '/api/routines': routine({ count: 0, last_due_at_utc: null, overlap_skipped: 0 }),
    });
    await renderWithProviders(<RoutinesPage />);
    await screen.findByText('Morning arXiv sweep');
    expect(screen.queryByText(/missed/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/skipped/i)).not.toBeInTheDocument();
  });

  test('a fire skipped as an overlap does not read as resmon having been closed', async () => {
    // The whole point of counting the two causes apart. Before the overlap
    // record existed the page had one line, and a fire refused while resmon
    // was demonstrably running would have been reported as missed while it was
    // closed -- a claim the app had no basis for.
    mockRoutedFetch({
      '/api/repositories/catalog': [], '/api/credentials': {},
      '/api/routines': routine({
        count: 2, last_due_at_utc: '2026-09-19T07:05:00+00:00',
        overlap_skipped: 2,
        last_overlap_skipped_due_at_utc: '2026-09-19T07:05:00+00:00',
        last_closed_miss_due_at_utc: null,
      }),
    });
    await renderWithProviders(<RoutinesPage />);
    expect(await screen.findByText(
      /skipped 2 fires because the previous run was still going; last due 2026-09-19T07:05:00\+00:00/,
    )).toBeInTheDocument();
    expect(screen.queryByText(/while resmon was closed/)).not.toBeInTheDocument();
    // No Run now beside an overlap skip: running it again is the wrong answer.
    expect(screen.queryByTestId('run-now-1')).not.toBeInTheDocument();
  });

  test('each line carries the time of its own cause, not the other\u2019s', async () => {
    // **The two timestamps are deliberately different, and the overlap skip is
    // deliberately the later one**, so `last_due_at_utc` -- the maximum over
    // every row -- is the skip's time. A fixture that gave both lines the same
    // time could not fail when the closed-miss line rendered the all-rows
    // maximum, which is exactly how that defect first shipped: the page read
    // `missed 1 fire while resmon was closed; last due 2026-09-19T07:05:00`,
    // stamping the closed sentence with the instant the line below it proves
    // resmon was running.
    mockRoutedFetch({
      '/api/repositories/catalog': [], '/api/credentials': {},
      '/api/routines': routine({
        count: 4, last_due_at_utc: '2026-09-19T07:05:00+00:00',
        overlap_skipped: 1,
        last_overlap_skipped_due_at_utc: '2026-09-19T07:05:00+00:00',
        last_closed_miss_due_at_utc: '2026-09-18T07:00:00+00:00',
      }),
    });
    await renderWithProviders(<RoutinesPage />);
    // Three of the four were missed while resmon was closed; one was refused
    // as an overlap. The closed count is the difference, not the total, and
    // the closed time is September 18, not the skip's September 19.
    expect(await screen.findByText(
      /missed 3 fires while resmon was closed; last due 2026-09-18T07:00:00\+00:00/,
    )).toBeInTheDocument();
    expect(screen.queryByText(
      /while resmon was closed; last due 2026-09-19T07:05:00\+00:00/,
    )).not.toBeInTheDocument();
    expect(screen.getByTestId('overlap-skipped-1')).toHaveTextContent(
      'last due 2026-09-19T07:05:00+00:00',
    );
    expect(screen.getByTestId('run-now-1')).toBeInTheDocument();
  });

  test('a backend answering neither new field keeps the old line, number and time', async () => {
    mockRoutedFetch({
      '/api/repositories/catalog': [], '/api/credentials': {},
      '/api/routines': routine({ count: 3, last_due_at_utc: '2026-09-19T07:00:00+00:00' }),
    });
    await renderWithProviders(<RoutinesPage />);
    expect(await screen.findByText(
      /missed 3 fires while resmon was closed; last due 2026-09-19T07:00:00\+00:00/,
    )).toBeInTheDocument();
    expect(screen.queryByTestId('overlap-skipped-1')).not.toBeInTheDocument();
  });
});
