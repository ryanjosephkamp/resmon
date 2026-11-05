import { jumpWords, monthEnd, monthWords, readJump, withJump } from '../jump';

describe('jumping the newest order to a month', () => {
  test('a month starts at its last day, so every paper of that month is in', () => {
    expect(monthEnd('2026-03')).toBe('2026-03-31');
    expect(monthEnd('2024-02')).toBe('2024-02-29');
    expect(monthEnd('2026-02')).toBe('2026-02-28');
    expect(monthEnd('2026-12')).toBe('2026-12-31');
    expect(monthWords('2026-03-31')).toBe('March 2026');
  });

  test('the month lives in the address beside the filters, and only a month is read from it', () => {
    const at = withJump(new URLSearchParams('q=perovskite&source=arxiv'), '2026-03');
    expect(at.toString()).toBe('q=perovskite&source=arxiv&at=2026-03');
    expect(readJump(at)).toBe('2026-03');
    expect(withJump(at, '').has('at')).toBe(false);
    expect(readJump(new URLSearchParams('at=March'))).toBeNull();
    expect(readJump(new URLSearchParams('at=2026-13'))).toBeNull();
  });

  test('the list says where it starts and how many newer matches come first, as the engine counted them', () => {
    expect(jumpWords({ newer_count: 184, newer_count_is_exact: true }, '2026-03'))
      .toBe('Listed from March 2026 back. 184 newer matches come before it in the newest order.');
    expect(jumpWords({ newer_count: 1, newer_count_is_exact: true }, '2026-03'))
      .toBe('Listed from March 2026 back. 1 newer match comes before it in the newest order.');
    expect(jumpWords({ newer_count: 0, newer_count_is_exact: true }, '2027-01'))
      .toBe('Listed from January 2027 back. No match was published after it.');
    expect(jumpWords({ newer_count: 41_200, newer_count_is_exact: false }, '2020-06'))
      .toBe('Listed from June 2020 back. At least 41,200 newer matches come before it in the newest order.');
  });
});
