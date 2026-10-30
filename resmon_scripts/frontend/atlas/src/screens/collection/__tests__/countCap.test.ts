import { capWords } from '../countCap';

describe('a capped count says so beside the number', () => {
  test('an exact count says nothing more', () => {
    expect(capWords({ total_is_capped: false, count_cap: 10000 }, 3)).toBeNull();
  });

  test('a capped count names the cap, and the whole collection’s own count where that is what was asked', () => {
    expect(capWords({ total_is_capped: true, count_cap: 10000 }, 16065))
      .toBe('Search stops counting at 10,000; your collection holds 16,065 papers in all.');
    expect(capWords({ total_is_capped: true, count_cap: 10000 }, null)).toBe('Search stops counting at 10,000.');
  });
});
