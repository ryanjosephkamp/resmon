/**
 * Today lists a group's first papers and more on request; a paper chosen on
 * the plate is listed however far down its group it is.
 */
import { GROUP_FIRST, GROUP_MORE, listedIn } from '../TodayIndex';

const group = Array.from({ length: 120 }, (_, i) => ({ id: 1000 + i }));

test('a group lists its first papers, and as many more as were asked for', () => {
  expect(GROUP_FIRST).toBe(25);
  expect(GROUP_MORE).toBe(50);
  expect(listedIn(group, GROUP_FIRST, null)).toBe(25);
  expect(listedIn(group, GROUP_FIRST + GROUP_MORE, null)).toBe(75);
  expect(listedIn(group.slice(0, 10), GROUP_FIRST, null)).toBe(10);
});

test('a paper chosen on the plate is listed, and nothing past it', () => {
  expect(listedIn(group, GROUP_FIRST, 1000 + 90)).toBe(91);
  expect(listedIn(group, GROUP_FIRST, 1000 + 3)).toBe(25);
  // Chosen in another group: this one is unchanged.
  expect(listedIn(group, GROUP_FIRST, 5)).toBe(25);
});
