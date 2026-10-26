/**
 * @jest-environment ./jest.easternZoneEnvironment.js
 */

/**
 * An upcoming routine fire says whether anything will run it.
 *
 * The popover said "Status: scheduled" for a routine the Routines page said
 * would not run. Found in a walk of the app on October 26, 2026. The verdict is
 * the one ``GET /api/scheduler/status`` gives the Routines page.
 */
import React from 'react';
import { act, fireEvent, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import CalendarPage from '../pages/CalendarPage';
import { mockRoutedFetch, renderWithProviders } from './testUtils';

/** Noon today, so the fire is in the month the calendar opens on. */
function noonToday(): string {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  return d.toISOString();
}

function fire() {
  const start = noonToday();
  return {
    id: `routine-1-${start}`, title: 'routine #1: midnight_agents', start, end: start,
    allDay: false, color: '#f59e0b', execution_id: null, routine_id: 1, type: 'routine',
    status: 'scheduled', query: 'agents', total_results: null, new_results: null,
  };
}

const ROUTINES = [{ id: 1, name: 'midnight_agents', is_active: 1, schedule_cron: '0 12 * * *' }];

function status(willFire: boolean | null) {
  return {
    state: willFire === true ? 'fires_here' : 'service_stopped', app_version: '2.3.0',
    service_installed: true, service_version: null,
    routines: [{ id: 1, will_fire: willFire, reason: willFire ? 'scheduled' : 'no_scheduler_running' }],
  };
}

async function openTheFire(): Promise<HTMLElement> {
  await act(async () => { fireEvent.click(screen.getByText('routine #1', { exact: false })); });
  const popover = document.querySelector('.event-popover');
  if (!popover) throw new Error('No popover opened');
  return popover as HTMLElement;
}

test('a fire nothing will run says so beside "scheduled"', async () => {
  mockRoutedFetch({
    '/api/calendar/events': [fire()], '/api/routines': ROUTINES,
    '/api/scheduler/status': status(false),
  });
  await renderWithProviders(<CalendarPage />, ['/calendar']);
  const popover = await openTheFire();
  expect(popover).toHaveTextContent('scheduled');
  expect(screen.getByTestId('calendar-firing-note')).toHaveTextContent('Will not run');
});

test('a fire nobody can confirm says that', async () => {
  mockRoutedFetch({
    '/api/calendar/events': [fire()], '/api/routines': ROUTINES,
    '/api/scheduler/status': status(null),
  });
  await renderWithProviders(<CalendarPage />, ['/calendar']);
  await openTheFire();
  expect(screen.getByTestId('calendar-firing-note')).toHaveTextContent('Not confirmed to run');
});

test('a fire that will run, or a backend that cannot say, adds nothing', async () => {
  mockRoutedFetch({
    '/api/calendar/events': [fire()], '/api/routines': ROUTINES,
    '/api/scheduler/status': status(true),
  });
  await renderWithProviders(<CalendarPage />, ['/calendar']);
  await openTheFire();
  expect(screen.queryByTestId('calendar-firing-note')).not.toBeInTheDocument();
});
