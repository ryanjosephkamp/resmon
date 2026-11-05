import { stoppedWords } from '../countCap';

describe('a count that ran out of time says so beside the number', () => {
  test('an exact count says nothing more', () => {
    expect(stoppedWords({ total: 16_774, total_is_exact: true, count_budget_ms: 1500 })).toBeNull();
  });

  test('a stopped count says when it stopped, and that the list and the export are not cut short by it', () => {
    expect(stoppedWords({ total: 41_200, total_is_exact: false, count_budget_ms: 1500 }))
      .toBe('Counting stopped after 1.5 seconds; the list and the export still hold every match.');
    expect(stoppedWords({ total: 3, total_is_exact: false, count_budget_ms: 1000 }))
      .toBe('Counting stopped after 1 second; the list and the export still hold every match.');
  });
});
