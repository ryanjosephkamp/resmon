import { foldedAway, standingInFor } from '../fold';

describe('a per-view fold', () => {
  // The engine's own shape: each group keyed by its kept row, listing every
  // member, the kept row among them.
  const preview = { 3: [3, 7], 10: [10, 11, 12] };

  test('hides every member but the row the group is kept as', () => {
    expect([...foldedAway(preview)].sort((a, b) => a - b)).toEqual([7, 11, 12]);
  });

  test('never hides a kept row, so no work disappears from the list', () => {
    const hidden = foldedAway(preview);
    expect(hidden.has(3)).toBe(false);
    expect(hidden.has(10)).toBe(false);
  });

  test('a kept row stands in for the others, not for itself', () => {
    expect(standingInFor(preview, 3)).toBe(1);
    expect(standingInFor(preview, 10)).toBe(2);
    expect(standingInFor(preview, 7)).toBe(0);
  });
});
