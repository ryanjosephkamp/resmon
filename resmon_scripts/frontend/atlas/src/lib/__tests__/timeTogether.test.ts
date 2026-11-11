/**
 * @jest-environment ./jest.easternZoneEnvironment.js
 */
import { runDays, runTime, runWhen, type WallRun } from '../../screens/health/model';
import { dayAndTime, eventTime } from '../../screens/runs/model';
import { clock, fullDate, when } from '../../screens/today/format';
import { scheduleText } from '../../screens/watches/model';
import { timeTogether } from '../timeTogether';

const KEPT = /\d\u00a0[AP]M\b/;
const BROKEN = /\d[ \u202f][AP]M\b/;

test('a time and its AM or PM are joined by a no-break space, whichever space Intl gave', () => {
  expect(timeTogether('11:35 AM')).toBe('11:35\u00a0AM');
  expect(timeTogether('11:35\u202fPM')).toBe('11:35\u00a0PM');
  expect(timeTogether('from 9:00 AM to 5:30 PM')).toBe('from 9:00\u00a0AM to 5:30\u00a0PM');
  // Only a time's half of the day: a word that begins with the letters is left alone.
  expect(timeTogether('8 AMPLE')).toBe('8 AMPLE');
});

test('every formatter that says a time of day keeps it whole', () => {
  const at = new Date('2026-11-03T16:56:12Z');
  const now = new Date('2026-11-03T18:00:00Z');
  const run: WallRun = { execution_id: 1, execution_type: 'automated_sweep', status: 'completed',
    started_at: '2026-11-03T16:56:12Z', ended_at: null, label: 'Watch' };
  const said = [when(at.toISOString(), now), clock(at.toISOString()), fullDate(at), runTime(run), runWhen(run),
    dayAndTime(at), eventTime('2026-11-03T16:56:12Z'), scheduleText('30 18 * * *') ?? ''];
  for (const text of said) {
    expect(text).toMatch(KEPT);
    expect(text).not.toMatch(BROKEN);
  }
});

test('the Source Wall keeps a day\'s month and date together, so a narrow heading breaks after the weekday', () => {
  const run: WallRun = { execution_id: 1, execution_type: 'automated_sweep', status: 'completed',
    started_at: '2026-10-30T16:00:00Z', ended_at: null, label: 'Watch' };
  expect(runDays([run])[0]?.day).toBe('Fri, Oct\u00a030');
  expect(runWhen(run)).toBe('Fri, Oct\u00a030, 12:00\u00a0PM');
});
