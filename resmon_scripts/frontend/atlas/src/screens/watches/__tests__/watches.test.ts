import { closeGroups, convexHull } from '../../sky/PaperSky';
import { deliveryWords, instant, promisedFires, scheduleText, watchAsks, type CalendarEvent } from '../model';

describe('scheduleText says only what the scheduler will do', () => {
  test.each([
    ['0 7 * * 1', 'Mondays at 7:00 AM'],
    ['0 6 * * *', 'Daily at 6:00 AM'],
    ['30 18 * * *', 'Daily at 6:30 PM'],
    ['0 0 * * *', 'Daily at 12:00 AM'],
    ['0 8 * * 1-5', 'Weekdays at 8:00 AM'],
    ['0 9 * * 7', 'Sundays at 9:00 AM'],
    ['0 9 * * 1,3,5', 'Mon, Wed, Fri at 9:00 AM'],
    ['*/5 * * * *', 'Every 5 minutes'],
    ['15 * * * *', 'Every hour, at :15'],
    ['0 */6 * * *', 'Every 6 hours'],
    ['0 0 1 * *', 'Monthly on day 1 at 12:00 AM'],
  ])('%s reads as "%s"', (cron, words) => {
    expect(scheduleText(cron)).toBe(words);
  });

  test.each(['0 0 */5 * *', '0 0 1 */2 *', '0 9-17 * * *', 'not a cron'])('%s is left as the expression', (cron) => {
    expect(scheduleText(cron)).toBeNull();
  });

  test('a structured schedule wins over the cron string, as it does when the routine fires', () => {
    const parameters = JSON.stringify({ _schedule: { type: 'interval', unit: 'weeks', every: 3, hour: 7, minute: 30 } });
    expect(scheduleText('0 0 */21 * *', parameters)).toBe('Every 3 weeks at 7:30 AM');
  });
});

describe('a watch, read out of what the engine stores', () => {
  test('its sources, terms, and whether it watches a person', () => {
    expect(watchAsks('{"repositories": ["arxiv", "dblp"], "keywords": ["a", "b"], "query": "a b"}'))
      .toEqual({ sources: ['arxiv', 'dblp'], keywords: ['a', 'b'], query: 'a b', person: false });
    expect(watchAsks('{"repository": "arxiv", "entity": {"profile_id": 3}}').person).toBe(true);
    expect(watchAsks('not json')).toEqual({ sources: [], keywords: [], query: '', person: false });
  });

  test("SQLite's zone-less timestamps are UTC, not this computer's time", () => {
    expect(instant('2026-10-28 22:04:26')?.toISOString()).toBe('2026-10-28T22:04:26.000Z');
    expect(instant('2026-10-29T09:00:00-04:00')?.toISOString()).toBe('2026-10-29T13:00:00.000Z');
    expect(instant(null)).toBeNull();
    expect(instant('soon')).toBeNull();
  });

  test('promised fires are the calendar\'s, for this watch, still to come, soonest first', () => {
    const now = new Date('2026-10-28T12:00:00Z');
    const event = (id: string, routine: number, start: string, status = 'scheduled') =>
      ({ id, routine_id: routine, start, status } as unknown as CalendarEvent);
    const fires = promisedFires([
      event('b', 1, '2026-10-30T09:00:00Z'),
      event('a', 1, '2026-10-29T09:00:00Z'),
      event('c', 2, '2026-10-29T08:00:00Z'),
      event('d', 1, '2026-10-27T09:00:00Z'),
      event('e', 1, '2026-10-29T07:00:00Z', 'completed'),
    ], 1, now);
    expect(fires.map((f) => f.id)).toEqual(['a', 'b']);
  });

  test('a delivery that failed and will be tried again says so; the others say their state', () => {
    expect(deliveryWords({ state: 'failed', next_attempt_at_utc: '2026-10-29T00:00:00Z' })).toBe('Failed, trying again');
    expect(deliveryWords({ state: 'failed', next_attempt_at_utc: null })).toBe('Failed');
    expect(deliveryWords({ state: 'awaiting_review', next_attempt_at_utc: null })).toBe('Waiting for you');
  });
});

describe('the constellation outlines', () => {
  test('the hull keeps the corners and drops what is inside', () => {
    const hull = convexHull([[0, 0], [4, 0], [4, 4], [0, 4], [2, 2], [1, 3]]);
    expect(hull).toHaveLength(4);
    expect(hull).not.toContainEqual([2, 2]);
  });

  test('close points chain into one group, a far one stays out, and small groups are dropped', () => {
    const near: [number, number][] = [[0, 0], [5, 0], [10, 0], [15, 0], [20, 0]];
    const groups = closeGroups([...near, [200, 200], [205, 200]], 6, 5);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(5);
    expect(closeGroups(near, 4, 5)).toHaveLength(0);
  });
});
