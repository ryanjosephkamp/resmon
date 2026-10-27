import { scheduleText } from '../lib/scheduleText';
import { titleFor } from '../components/Layout/Header';
import { runTypeLabel, matchesRunTypeFilter } from '../lib/labels';

describe('scheduleText says only what the scheduler will do', () => {
  test.each([
    ['0 7 * * 1', 'Mondays at 7:00 AM'],
    ['0 6 * * *', 'Daily at 6:00 AM'],
    ['30 18 * * *', 'Daily at 6:30 PM'],
    ['0 0 * * *', 'Daily at 12:00 AM'],
    ['0 8 * * 1-5', 'Weekdays at 8:00 AM'],
    ['0 9 * * 0', 'Sundays at 9:00 AM'],
    ['0 9 * * 7', 'Sundays at 9:00 AM'],
    ['0 9 * * 1,3,5', 'Mon, Wed, Fri at 9:00 AM'],
    ['*/5 * * * *', 'Every 5 minutes'],
    ['* * * * *', 'Every minute'],
    ['0 * * * *', 'Every hour'],
    ['15 * * * *', 'Every hour, at :15'],
    ['0 */6 * * *', 'Every 6 hours'],
    ['0 0 1 * *', 'Monthly on day 1 at 12:00 AM'],
  ])('%s reads as "%s"', (cron, words) => {
    expect(scheduleText(cron)).toBe(words);
  });

  test.each([
    // Cron's */N in the day of the month restarts every month, so "every 5
    // days" would be a claim the scheduler does not keep.
    '0 0 */5 * *',
    '0 0 1 */2 *',
    '0 9-17 * * *',
    'not a cron',
    '0 7 * *',
  ])('%s is left as the expression itself', (cron) => {
    expect(scheduleText(cron)).toBeNull();
  });

  test('a structured schedule wins over the cron string, as it does in the scheduler', () => {
    const parameters = { _schedule: { type: 'interval', unit: 'weeks', every: 3, hour: 7, minute: 30 } };
    expect(scheduleText('0 0 */21 * *', parameters)).toBe('Every 3 weeks at 7:30 AM');
    expect(scheduleText('0 0 */21 * *', JSON.stringify(parameters))).toBe('Every 3 weeks at 7:30 AM');
    expect(scheduleText('0 0 * * *', { _schedule: { type: 'interval', unit: 'hours', every: 4, minute: 0 } }))
      .toBe('Every 4 hours');
  });

  test('a structured schedule the scheduler would ignore is ignored here too', () => {
    expect(scheduleText('0 6 * * *', { _schedule: { type: 'interval', unit: 'fortnights', every: 1 } }))
      .toBe('Daily at 6:00 AM');
    expect(scheduleText('0 6 * * *', { _schedule: { type: 'interval', unit: 'days', every: 0 } }))
      .toBe('Daily at 6:00 AM');
  });
});

describe('the header names every page', () => {
  test.each([
    ['/', 'Dashboard'],
    ['/analytics', 'Analytics'],
    ['/explorer', 'Explorer'],
    ['/profiles', 'Watch Profiles'],
    ['/monitor', 'Monitor'],
    ['/repositories', 'Repositories & API Keys'],
    ['/settings/advanced', 'Settings'],
    ['/about-resmon/blog', 'About resmon'],
  ])('%s is headed "%s"', (path, title) => {
    expect(titleFor(path)).toBe(title);
  });
});

describe('run types read as the pages name them', () => {
  test('labels', () => {
    expect(runTypeLabel('deep_dive')).toBe('Deep Dive');
    expect(runTypeLabel('deep_sweep')).toBe('Deep Sweep');
    expect(runTypeLabel('automated_sweep')).toBe('Routine');
    expect(runTypeLabel('something_new')).toBe('something_new');
  });

  test('the Routine filter keeps the runs routines fired', () => {
    expect(matchesRunTypeFilter('automated_sweep', 'routine')).toBe(true);
    expect(matchesRunTypeFilter('deep_dive', 'routine')).toBe(false);
    expect(matchesRunTypeFilter('deep_dive', '')).toBe(true);
  });
});
