/**
 * @jest-environment ./jest.easternZoneEnvironment.js
 */

/**
 * Properties of the one place a stored timestamp becomes text.
 *
 * These are **new coverage, not a regression witness**: `src/lib/datetime.ts`
 * did not exist before the calendar fix, so nothing here was red against the
 * unfixed app. The test that was red is `CalendarEventTime.test.tsx`, which
 * asserts what a reader sees. This file exists for the branches that one
 * cannot reach — chiefly the bare, zone-less string, which is the shape most
 * likely to be read wrongly and least likely to be noticed.
 *
 * The zone is pinned by the environment named in the docblock above, not by a
 * `process.env.TZ` line here: Jest fixes the zone when it builds the
 * environment, before this module is required, so such a line does nothing
 * except pass on a machine that already agreed with it. The first test below
 * checks the environment took.
 */

import { formatInstant, parseStoredInstant } from '../lib/datetime';

describe('parseStoredInstant', () => {
  test('the environment is on a non-UTC zone, or nothing below means anything', () => {
    expect(new Date('2026-10-20T00:47:00Z').getHours()).toBe(20);
  });

  test('reads the three spellings of one instant as one instant', () => {
    const ms = Date.UTC(2026, 9, 20, 0, 47, 0);
    expect(parseStoredInstant('2026-10-20T00:47:00Z')?.getTime()).toBe(ms);
    expect(parseStoredInstant('2026-10-20T00:47:00+00:00')?.getTime()).toBe(ms);
    expect(parseStoredInstant('2026-10-19T20:47:00-04:00')?.getTime()).toBe(ms);
  });

  test('completes a zone-less timestamp as UTC, not as local', () => {
    // The branch that matters. Left to the default parser, ECMA-262 reads
    // this as local time, which would be wrong by the viewer's offset and
    // wrong without any symptom a reader could notice. resmon writes UTC, so
    // UTC is what a bare string means.
    const bare = parseStoredInstant('2026-10-20T00:47:00');
    expect(bare?.getTime()).toBe(Date.UTC(2026, 9, 20, 0, 47, 0));
    expect(bare?.getTime()).not.toBe(new Date('2026-10-20T00:47:00').getTime());
  });

  test('accepts the space-separated form some older rows carry', () => {
    expect(parseStoredInstant('2026-10-20 00:47:00')?.getTime())
      .toBe(Date.UTC(2026, 9, 20, 0, 47, 0));
  });

  test('returns null for what is not a timestamp', () => {
    for (const bad of [null, undefined, '', '   ', 'never', '2026-13-45T99:99:99Z']) {
      expect(parseStoredInstant(bad as string | null | undefined)).toBeNull();
    }
  });
});

describe('formatInstant', () => {
  test('renders the viewer’s local wall clock with the zone named', () => {
    expect(formatInstant('2026-10-20T00:47:00Z')).toBe('2026-10-19 20:47 EDT');
  });

  test('follows the viewer across a daylight-saving boundary', () => {
    // Same clock time in UTC, four months apart: the offset and the zone
    // abbreviation both have to move, and a hard-coded "-4" or "EDT" would
    // survive the test above and fail here.
    expect(formatInstant('2026-01-20T00:47:00Z')).toBe('2026-01-19 19:47 EST');
  });

  test('renders midnight as 00:00, never 24:00', () => {
    // A 24:00 would put the run on the previous day in the reader's eyes —
    // the same defect this module was written to close, by another route.
    expect(formatInstant('2026-10-20T04:00:00Z')).toBe('2026-10-20 00:00 EDT');
  });

  test('every spelling of one instant renders to one string', () => {
    const rendered = new Set([
      formatInstant('2026-10-20T00:47:00Z'),
      formatInstant('2026-10-20T00:47:00+00:00'),
      formatInstant('2026-10-19T20:47:00-04:00'),
      formatInstant('2026-10-20T00:47:00'),
      formatInstant('2026-10-20 00:47:00'),
    ]);
    expect([...rendered]).toEqual(['2026-10-19 20:47 EDT']);
  });

  test('honors an explicit zone, including zones with no abbreviation', () => {
    expect(formatInstant('2026-10-20T00:47:00Z', 'UTC')).toBe('2026-10-20 00:47 UTC');
    expect(formatInstant('2026-10-20T00:47:00Z', 'Europe/Berlin')).toBe('2026-10-20 02:47 GMT+2');
    expect(formatInstant('2026-10-20T00:47:00Z', 'Asia/Kolkata')).toBe('2026-10-20 06:17 GMT+5:30');
  });

  test('always carries a zone marker, whatever it was given', () => {
    for (const value of [
      '2026-10-20T00:47:00Z',
      '2026-10-19T20:47:00-04:00',
      '2026-01-20T00:47:00',
      '2026-10-20 00:47:00',
    ]) {
      expect(formatInstant(value)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} \S+$/);
    }
  });

  test('a date-only value comes back as the previous evening — the documented trap', () => {
    // Pins the worked example in `formatInstant`'s docstring, so the warning
    // cannot quietly stop being true. This is not a bug being enshrined: a
    // bare date is UTC midnight, and UTC midnight is the evening before
    // everywhere west of Greenwich. It is the right answer to the wrong
    // question, which is the dangerous kind.
    //
    // It is here because the obvious way to clean up the surfaces that still
    // render dates with `.slice(0, 10)` is to reach for `formatInstant`, and
    // that would ship the exact off-by-a-day the cleanup exists to remove.
    expect(formatInstant('2026-10-20')).toBe('2026-10-19 20:00 EDT');
    expect(formatInstant('2026-01-20')).toBe('2026-01-19 19:00 EST');
  });

  test('hands back a value it cannot read, rather than hiding it', () => {
    // An empty cell would say "there is no time here", which is a different
    // and untrue statement. Showing the stored characters says "resmon holds
    // this and does not understand it", which is what happened.
    expect(formatInstant('not a timestamp')).toBe('not a timestamp');
    expect(formatInstant(null)).toBe('');
    expect(formatInstant(undefined)).toBe('');
  });
});
