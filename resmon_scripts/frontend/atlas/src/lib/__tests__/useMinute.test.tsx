import { act, renderHook } from '@testing-library/react';
import { useMinute } from '../useMinute';

describe('useMinute', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  test('holds the time it was read at until the top of the next minute, then moves by whole minutes', () => {
    jest.setSystemTime(new Date('2026-11-03T03:07:40Z'));
    const { result } = renderHook(() => useMinute());
    expect(result.current.toISOString()).toBe('2026-11-03T03:07:40.000Z');

    act(() => { jest.advanceTimersByTime(19_000); });
    expect(result.current.toISOString()).toBe('2026-11-03T03:07:40.000Z');

    act(() => { jest.advanceTimersByTime(1_000); });
    expect(result.current.toISOString()).toBe('2026-11-03T03:08:00.000Z');

    act(() => { jest.advanceTimersByTime(60_000); });
    expect(result.current.toISOString()).toBe('2026-11-03T03:09:00.000Z');
  });

  test('stops its timer when the page that holds it goes', () => {
    const { unmount } = renderHook(() => useMinute());
    expect(jest.getTimerCount()).toBe(1);
    unmount();
    expect(jest.getTimerCount()).toBe(0);
  });
});
