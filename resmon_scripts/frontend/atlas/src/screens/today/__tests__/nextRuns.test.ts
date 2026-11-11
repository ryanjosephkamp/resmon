/**
 * @jest-environment ./jest.easternZoneEnvironment.js
 */
import { nextRunsWords } from '../format';

// 3:00 PM on November 10, 2026, in New York.
const NOW = new Date('2026-11-10T20:00:00Z');
const MIDNIGHT = '2026-11-11T05:00:00Z';
const EIGHT = '2026-11-11T13:00:00Z';
const NINE = '2026-11-11T14:00:00Z';
const at = (words: string) => words.replace(/ (AM|PM)/g, ' $1');

test('two watches at one time are one time with a count, never the same words twice', () => {
  expect(nextRunsWords([MIDNIGHT, MIDNIGHT], NOW)).toBe(at('tomorrow at 12:00 AM (2 watches)'));
  expect(nextRunsWords([EIGHT, MIDNIGHT, MIDNIGHT], NOW)).toBe(at('tomorrow at 12:00 AM (2 watches) and tomorrow at 8:00 AM'));
});

test('times within one minute read as one, and only the first two times are named', () => {
  expect(nextRunsWords(['2026-11-11T05:00:10Z', '2026-11-11T05:00:40Z', NINE, EIGHT], NOW))
    .toBe(at('tomorrow at 12:00 AM (2 watches) and tomorrow at 8:00 AM'));
  expect(nextRunsWords([EIGHT], NOW)).toBe(at('tomorrow at 8:00 AM'));
  expect(nextRunsWords([], NOW)).toBe('');
});
