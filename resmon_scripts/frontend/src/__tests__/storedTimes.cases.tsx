/**
 * What a reader sees for a stored timestamp, on every surface that used to cut
 * one up as a string — run in two zones.
 *
 * resmon stores instants in UTC: ``utils.now_iso()`` writes
 * ``2026-10-20T00:47:00Z``, ``database.utc_now_iso()`` writes
 * ``2026-10-20T00:47:00.123456+00:00``, and SQLite's ``datetime('now')``
 * default writes ``2026-10-20 00:47:00`` with no zone at all. Seven renderer
 * surfaces turned those into text by slicing characters off them. Sliced to
 * sixteen, a UTC wall clock was shown with nothing to say it was UTC; sliced
 * to ten, a UTC *date* was shown, which for anyone west of Greenwich in the
 * evening is tomorrow. The "Last 7d" preset made the same mistake in the other
 * direction, building its window from ``toISOString()`` and so ending it on a
 * date that had not arrived yet where the user was sitting.
 *
 * Which of the two a value *is* — an instant or a calendar date — was decided
 * from where the backend writes it, not from its string shape:
 *
 *   - ``executions.start_time`` (Dashboard, Results, both Analytics sites):
 *     ``sweep_engine`` writes ``now_iso()``; a restart writes
 *     ``utc_now_iso()``. An instant.
 *   - ``saved_configurations.created_at`` (Configurations): column default
 *     ``datetime('now')``. An instant.
 *   - ``reading_queue.saved_at`` / ``read_at`` (Reading queue): column default
 *     and ``set_status`` both ``datetime('now')``. Instants.
 *   - ``routines.last_executed_at`` (Dashboard, Active Routines): stamped
 *     with ``datetime('now')`` at fire time. An instant.
 *   - The date-range preset's two bounds: calendar dates the user's window is
 *     made of, read by the sources as dates.
 *
 * So no surface here shows a stored *calendar date*; the three that show a
 * date are showing the day an instant fell on, and that day depends on where
 * the reader is.
 *
 * **Why two zones.** The evening fixture below is 8:47 PM on October 19 in New
 * York and 00:47 on October 20 in UTC. In New York every one of these
 * surfaces was wrong — that leg is the regression witness. In UTC the old
 * dates happened to be right and the old clocks were right but unlabeled; that
 * leg is the control, and it fails any fix that only works by knowing the
 * offset of the zone the author was sitting in.
 *
 * The zone is pinned by the Jest environment the runner file names, never by
 * a ``process.env.TZ`` line here, which does nothing (see
 * ``jest.zonedEnvironment.js``). The first test in each run checks the pin
 * took, because every other assertion is meaningless if it did not.
 *
 * Runners: ``storedTimes.eastern.test.tsx`` and ``storedTimes.utc.test.tsx``.
 * This file does not match ``testMatch`` on purpose; it runs only through them.
 */

import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import AnalyticsPage from '../pages/AnalyticsPage';
import ConfigurationsPage from '../pages/ConfigurationsPage';
import DashboardPage from '../pages/DashboardPage';
import ReadingQueuePage from '../pages/ReadingQueuePage';
import ResultsList from '../components/Results/ResultsList';
import DateRangePicker from '../components/Forms/DateRangePicker';
import { calendarDateOf, formatInstantDate } from '../lib/datetime';
import { mockRoutedFetch, renderWithProviders } from './testUtils';

export type PinnedZone = 'America/New_York' | 'UTC';

/**
 * One instant — 8:47 PM EDT on Monday, October 19, 2026 — in each of the
 * three spellings the backend writes it in.
 */
const EVENING = {
  nowIso: '2026-10-20T00:47:00Z',
  utcNowIso: '2026-10-20T00:47:00.123456+00:00',
  sqliteNow: '2026-10-20 00:47:00',
};

/**
 * 11:30 PM EST on Sunday, November 1, 2026: the first evening after daylight
 * saving ended. Seven calendar days earlier is October 25, which was on EDT,
 * so the week is 167 hours long rather than 168. A preset that subtracted
 * ``7 * 86_400_000`` milliseconds would land on 00:30 on October 26 and
 * miss the first day of the window.
 */
const AFTER_DST_ENDS = '2026-11-02T04:30:00Z';

interface Expected {
  /** ``formatInstant`` of the evening instant. */
  clock: string;
  /** The calendar day the evening instant fell on, where the reader is. */
  day: string;
  /** "Last 7d" and "Last 24h" pressed on that evening. */
  last7: [string, string];
  last24h: [string, string];
  /** "Last 7d" pressed on the evening after daylight saving ended. */
  last7AfterDst: [string, string];
}

const EXPECTED: Record<PinnedZone, Expected> = {
  'America/New_York': {
    clock: '2026-10-19 20:47 EDT',
    day: '2026-10-19',
    last7: ['2026-10-12', '2026-10-19'],
    last24h: ['2026-10-18', '2026-10-19'],
    last7AfterDst: ['2026-10-25', '2026-11-01'],
  },
  UTC: {
    clock: '2026-10-20 00:47 UTC',
    day: '2026-10-20',
    last7: ['2026-10-13', '2026-10-20'],
    last24h: ['2026-10-19', '2026-10-20'],
    last7AfterDst: ['2026-10-26', '2026-11-02'],
  },
};

/** The text of the first cell in the table row that holds ``label``. */
function firstCellOfRowWith(label: string): string {
  const row = screen.getByText(label).closest('tr');
  if (!row) throw new Error(`No table row holds ${label}`);
  return row.querySelectorAll('td')[0]?.textContent ?? '';
}

export function describeStoredTimes(zone: PinnedZone): void {
  const want = EXPECTED[zone];

  describe(`stored times, read in ${zone}`, () => {
    test('the environment is pinned to the zone this run is about', () => {
      expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(zone);
      // And the evening fixture really is evening there, or midnight in UTC.
      expect(new Date(EVENING.nowIso).getHours()).toBe(zone === 'UTC' ? 0 : 20);
    });

    test('Dashboard: a run’s start is the reader’s clock, with its zone', async () => {
      mockRoutedFetch({
        '/api/routines': [],
        '/api/executions': [{
          id: 21, execution_type: 'deep_dive', status: 'completed',
          start_time: EVENING.nowIso, result_count: 3, new_result_count: 1,
          keywords: ['codex walk'], repositories: ['arxiv'],
        }],
        '/api/watchdog': { counts: { broken: 0, unusual: 0, alarms: 0 }, sufficient: false },
      });
      await renderWithProviders(<DashboardPage />);

      expect(firstCellOfRowWith('Execution #21')).toBe(want.clock);
    });

    test('Dashboard: a routine’s last run is the same clock, not the stored characters', async () => {
      // Not one of the six string-cutting sites: this cell printed
      // ``last_executed_at`` raw, and ``datetime('now')`` writes it with no
      // zone. It sits one card above the run table, so leaving it would put
      // two clocks for one moment on one page.
      mockRoutedFetch({
        '/api/routines': [{
          id: 4, name: 'Nightly codex', schedule_cron: '47 20 * * *', is_active: 1,
          last_executed_at: EVENING.sqliteNow,
        }],
        '/api/executions': [],
        '/api/watchdog': { counts: { broken: 0, unusual: 0, alarms: 0 }, sufficient: false },
      });
      await renderWithProviders(<DashboardPage />);

      const row = screen.getByText('Nightly codex').closest('tr');
      expect(row?.querySelectorAll('td')[3]?.textContent).toBe(want.clock);
    });

    test('Results: every spelling of a run’s start renders as one clock', () => {
      const base = {
        execution_type: 'deep_sweep', status: 'completed',
        total_results: 3, new_results: 1, keywords: ['codex walk'], repositories: ['arxiv'],
      };
      render(
        <ResultsList
          executions={[
            { ...base, id: 31, start_time: EVENING.nowIso },
            // A restarted run is stamped by ``utc_now_iso()``, microseconds
            // and a numeric offset included.
            { ...base, id: 32, start_time: EVENING.utcNowIso },
          ] as unknown as React.ComponentProps<typeof ResultsList>['executions']}
          selected={new Set<number>()}
          onToggle={jest.fn()}
          onToggleAll={jest.fn()}
          onRowClick={jest.fn()}
          typeFilter=""
          statusFilter=""
          onTypeFilterChange={jest.fn()}
          onStatusFilterChange={jest.fn()}
        />,
      );

      for (const label of ['Execution #31', 'Execution #32']) {
        const row = screen.getByText(label).closest('tr');
        // Column 0 is the selection checkbox; the start is column 1.
        expect(row?.querySelectorAll('td')[1]?.textContent).toBe(want.clock);
      }
    });

    test('Configurations: when a configuration was created is the reader’s clock, with its zone', async () => {
      mockRoutedFetch({
        '/api/repositories/catalog': [],
        '/api/credentials': {},
        '/api/configurations': [{
          id: 7, name: 'codex-walk', config_type: 'routine',
          parameters: JSON.stringify({ keywords: ['codex walk'], repositories: ['arxiv'] }),
          created_at: EVENING.sqliteNow,
        }],
      });
      await renderWithProviders(<ConfigurationsPage />);

      const row = screen.getByText('codex-walk').closest('tr');
      // Column 0 is the checkbox, then name, type, created.
      expect(row?.querySelectorAll('td')[3]?.textContent).toBe(want.clock);
    });

    test('Analytics: the day a routine last found something is the reader’s day', async () => {
      mockRoutedFetch({ '/api/analytics/overview': analyticsOverview() });
      await renderWithProviders(<AnalyticsPage />);

      expect(screen.getByText(/Last new paper:/).textContent)
        .toContain(`Last new paper: ${want.day}.`);
    });

    test('Analytics: each bar of a routine’s history is labeled with the reader’s day', async () => {
      mockRoutedFetch({ '/api/analytics/overview': analyticsOverview() });
      await renderWithProviders(<AnalyticsPage />);

      const titles = Array.from(document.querySelectorAll('.analytics-spark-bar'))
        .map((bar) => bar.getAttribute('title'));
      // The first bar is a run on the evening; the second is the next
      // morning in both zones, so it is the same day in each and pins that
      // the bars are not simply all shifted by one.
      expect(titles).toEqual([`${want.day}: 3 new`, '2026-10-20: 0 new']);
    });

    test('Reading queue: the days a paper was saved and read are the reader’s days', async () => {
      mockRoutedFetch({
        '/api/reading-queue': {
          entries: [{
            document_id: 1, status: 'read',
            saved_at: EVENING.sqliteNow, updated_at: EVENING.sqliteNow, read_at: EVENING.sqliteNow,
            document: {
              id: 1, source_repository: 'arxiv', external_id: 'synthetic-1', doi: null,
              title: 'Paper 1', authors: 'Ada Lovelace', abstract: 'A synthetic abstract.',
              // A calendar date, deliberately the same characters as the
              // UTC day: it must render as written in both zones.
              publication_date: '2026-10-20', url: 'https://example.invalid/p',
              categories: 'fixture', queue_status: 'read',
            },
          }],
          total: 1, limit: 50, offset: 0, status: null,
          counts: { to_read: 0, read: 1, all: 1 },
        },
      });
      await renderWithProviders(<ReadingQueuePage />);

      expect(screen.getByText(/^Saved /).textContent).toBe(`Saved ${want.day}`);
      expect(screen.getByText(/^Read \d/).textContent).toBe(`Read ${want.day}`);
      expect(screen.getByText('2026-10-20')).toBeInTheDocument();
    });

    test('the shared date functions answer in this zone when none is named', () => {
      // What every surface above calls. The explicit-zone cases are in
      // ``datetime.test.ts``; this is the default path, in the pinned zone.
      expect(formatInstantDate(EVENING.sqliteNow)).toBe(want.day);
      expect(calendarDateOf(new Date(EVENING.nowIso))).toBe(want.day);
      // And a calendar date stays the date it names, here as everywhere.
      expect(formatInstantDate('2026-10-20')).toBe('2026-10-20');
    });

    describe('the date-range presets', () => {
      afterEach(() => {
        jest.useRealTimers();
      });

      function pressPreset(label: string, now: string): [string, string] {
        jest.useFakeTimers({ now: new Date(now) });
        const onFrom = jest.fn();
        const onTo = jest.fn();
        render(
          <DateRangePicker dateFrom="" dateTo="" onDateFromChange={onFrom} onDateToChange={onTo} />,
        );
        act(() => { fireEvent.click(screen.getByRole('button', { name: label })); });
        expect(onFrom).toHaveBeenCalledTimes(1);
        expect(onTo).toHaveBeenCalledTimes(1);
        return [onFrom.mock.calls[0][0], onTo.mock.calls[0][0]];
      }

      test('"Last 7d" ends today where the reader is, not where UTC is', () => {
        expect(pressPreset('Last 7d', EVENING.nowIso)).toEqual(want.last7);
      });

      test('"Last 24h" is yesterday and today where the reader is', () => {
        expect(pressPreset('Last 24h', EVENING.nowIso)).toEqual(want.last24h);
      });

      test('"Last 7d" counts calendar days across a daylight-saving change', () => {
        expect(pressPreset('Last 7d', AFTER_DST_ENDS)).toEqual(want.last7AfterDst);
      });
    });
  });
}

/**
 * An overview with a corpus and one routine with a run history. Only the
 * routine-health section is under test; the others say they lack data, which
 * is a state the page renders without help.
 */
function analyticsOverview() {
  const notYet = (reason: string) => ({ sufficient: false, insufficient_reason: reason });
  return {
    summary: {
      documents: 4, unique_papers: 4, distinct_authors: 4, sources: 1,
      completed_executions: 3, doi_coverage: null, sample_size: 4, sufficient: true,
    },
    source_contribution: { sources: [], sample_size: 0, ...notYet('Needs two sources.') },
    discovery_lag: { sources: [], sample_size: 0, minimum_sample: 5, ...notYet('Needs dated papers.') },
    routine_health: {
      routines: [{
        routine_id: 1, name: 'Nightly codex', is_active: true, runs: 3,
        runs_since_new: 1, last_new_result_at: EVENING.nowIso, total_new: 3,
        status: 'healthy',
        series: [
          { start_time: EVENING.nowIso, new_results: 3 },
          // 14:00 UTC is 10:00 EDT: the same date in both zones.
          { start_time: '2026-10-20T14:00:00Z', new_results: 0 },
        ],
      }],
      minimum_runs: 3, stale_after: 3, sample_size: 1, sufficient: true, insufficient_reason: null,
    },
    publication_volume: {
      group_by: 'source', groups: [], series: [], sample_size: 0, ...notYet('No dated papers.'),
    },
  };
}
