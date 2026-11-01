/**
 * @jest-environment ./jest.easternZoneEnvironment.js
 */

/**
 * One execution, one time.
 *
 * The calendar renders the same instant twice: once as a position in the
 * month grid, and once as the ``Start:`` line of the popover the user opens
 * by clicking it. Those two readings disagreed. A completed run whose stored
 * ``start_time`` is ``2026-10-20T00:47:00Z`` sat in the October 19 cell at
 * 8:47 PM -- correct for America/New_York -- while its own popover said
 * ``2026-10-20 00:47``, four hours and a calendar day later, with nothing on
 * screen to say which of the two the reader was looking at.
 *
 * The grid was right. ``start_time`` is written by ``utils.now_iso()`` as
 * ``%Y-%m-%dT%H:%M:%SZ``, so it is a UTC instant and FullCalendar placed it
 * in the browser's zone. The popover was printing the stored characters:
 * ``start.replace('T', ' ').slice(0, 16)`` drops the ``Z`` along with the
 * seconds and hands the reader a UTC wall clock dressed as a local one.
 *
 * So these tests pin a non-UTC zone and assert the *rendered text* of both
 * readings. Asserting that the two call the same helper would prove nothing
 * about what the user reads; asserting the text fails the moment the
 * formatting is reverted, which is the only property worth having here.
 *
 * The zone comes from the custom environment named in the docblock above, and
 * not from a ``process.env.TZ`` line in this file. That line was the first
 * attempt and it is a no-op: Jest fixes the zone when it builds the
 * environment, before this module is required, so the assignment passed on a
 * laptop already in Eastern time and reported ``UTC`` on CI. The first test
 * below checks the environment actually took, because every other assertion
 * here is meaningless if it did not.
 */

import React from 'react';
import { act, fireEvent, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import CalendarPage from '../pages/CalendarPage';
import { mockRoutedFetch, renderWithProviders } from './testUtils';

/**
 * A completed deep dive stored exactly as the backend stores one: a UTC
 * instant with the ``Z`` marker, from ``implementation_scripts/utils.now_iso``.
 * In America/New_York this is 8:47 PM on October 19, the previous day.
 */
const UTC_EXECUTION = {
  id: 14,
  title: 'deep_dive #14: codex-walk',
  start: '2026-10-20T00:47:00Z',
  end: '2026-10-20T00:48:00Z',
  allDay: false,
  color: '#22c55e',
  execution_id: 14,
  routine_id: null,
  type: 'deep_dive',
  status: 'completed',
  query: 'codex-walk',
  total_results: 10,
  new_results: 10,
  saved_configuration_id: null,
  saved_configuration_name: null,
};

/**
 * A scheduled routine fire as the backend emits one: APScheduler's next fire
 * time, serialized with the machine's own offset rather than ``Z``. It is the
 * same instant as the execution above, written the other way, so a formatter
 * that only knows how to read one of the two shapes cannot pass both tests.
 */
const OFFSET_FIRE = {
  id: 'routine-1-2026-10-19T20:47:00-04:00',
  title: 'routine #1: llm_safety',
  start: '2026-10-19T20:47:00-04:00',
  end: '2026-10-19T20:48:00-04:00',
  allDay: false,
  color: '#f59e0b',
  execution_id: null,
  routine_id: 1,
  type: 'routine',
  status: 'scheduled',
  query: 'llm safety',
  total_results: null,
  new_results: null,
};

const ROUTINES = [
  { id: 1, name: 'llm_safety', is_active: 1, schedule_cron: '47 0 * * *' },
];

function routes(events: unknown[]) {
  return {
    '/api/calendar/events': events,
    '/api/routines': ROUTINES,
  };
}

/** Open the popover for an event by clicking its title in the grid. */
async function openPopoverFor(title: string): Promise<HTMLElement> {
  const link = screen.getByText(title, { exact: false });
  await act(async () => {
    fireEvent.click(link);
  });
  const popover = document.querySelector('.event-popover');
  if (!popover) throw new Error(`No popover opened for "${title}"`);
  return popover as HTMLElement;
}

/** The popover's ``Start:`` line, whitespace-normalized. */
function startLine(popover: HTMLElement): string {
  const line = [...popover.querySelectorAll('.event-popover-meta > div')]
    .map((d) => (d.textContent ?? '').replace(/\s+/g, ' ').trim())
    .find((t) => t.startsWith('Start:'));
  if (!line) throw new Error('No Start: line in the popover');
  return line;
}

describe('Calendar — the grid and the popover tell the same time', () => {
  // The calendar opens on the current month, and every run here is in October
  // 2026, so the file passed only until November 1. Only the clock is fixed:
  // the page's own timers and the awaited renders run as they do in the app.
  beforeEach(() => {
    jest.useFakeTimers({
      now: new Date('2026-10-25T16:00:00Z'),
      doNotFake: [
        'hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame',
        'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback', 'setImmediate',
        'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout',
      ],
    });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test('the test environment really is on a non-UTC zone', () => {
    // Without this the rest of the file would pass against a UTC machine
    // while the defect was fully intact, which is the failure mode this
    // whole file exists to rule out.
    const d = new Date('2026-10-20T00:47:00Z');
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(9); // October
    expect(d.getDate()).toBe(19); // the previous day, locally
    expect(d.getHours()).toBe(20); // 8 PM
  });

  test('the grid places the run on the local day — it was always the right one', async () => {
    // Establishes which of the two disagreeing readings was correct, rather
    // than assuming it. The run's instant is 00:47 UTC on October 20; the
    // grid must put it in the October 19 cell, because that is the day it
    // happened where the reader is.
    mockRoutedFetch(routes([UTC_EXECUTION]));
    await renderWithProviders(<CalendarPage />, ['/calendar']);

    const localCell = document.querySelector('[data-date="2026-10-19"]');
    const utcCell = document.querySelector('[data-date="2026-10-20"]');
    expect(localCell?.textContent).toContain('deep_dive #14');
    expect(utcCell?.textContent).not.toContain('deep_dive #14');
  });

  test('a UTC instant reads as the user’s local time, with a zone marker', async () => {
    mockRoutedFetch(routes([UTC_EXECUTION]));
    await renderWithProviders(<CalendarPage />, ['/calendar']);

    const popover = await openPopoverFor('deep_dive #14');

    // The time the reader is owed: the same instant the grid placed on
    // October 19, said in words, and labeled so it cannot be mistaken for
    // anything else.
    expect(startLine(popover)).toBe('Start: 2026-10-19 20:47 EDT');
  });

  test('an offset-carrying scheduled fire reads the same way', async () => {
    mockRoutedFetch(routes([OFFSET_FIRE]));
    await renderWithProviders(<CalendarPage />, ['/calendar']);

    const popover = await openPopoverFor('routine #1');

    expect(startLine(popover)).toBe('Start: 2026-10-19 20:47 EDT');
  });

  test('the two spellings of one instant render identically', async () => {
    // The backend writes executions with ``Z`` and scheduled fires with a
    // numeric offset. Both are the same kind of fact and the popover must
    // not be able to tell the reader otherwise.
    mockRoutedFetch(routes([UTC_EXECUTION, OFFSET_FIRE]));
    await renderWithProviders(<CalendarPage />, ['/calendar']);

    const fromExecution = startLine(await openPopoverFor('deep_dive #14'));
    const fromFire = startLine(await openPopoverFor('routine #1'));

    expect(fromExecution).toBe(fromFire);
  });

  test('no popover ever prints a bare, unlabeled wall clock', async () => {
    mockRoutedFetch(routes([UTC_EXECUTION, OFFSET_FIRE]));
    await renderWithProviders(<CalendarPage />, ['/calendar']);

    for (const title of ['deep_dive #14', 'routine #1']) {
      const line = startLine(await openPopoverFor(title));
      // A time with no zone is the defect, whichever zone it happens to be
      // right about. Require a trailing alphabetic marker.
      expect(line).toMatch(/^Start: \d{4}-\d{2}-\d{2} \d{2}:\d{2} [A-Za-z]/);
    }
  });
});
