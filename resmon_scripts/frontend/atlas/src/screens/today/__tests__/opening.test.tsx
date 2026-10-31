import { StrictMode, type ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { OPENING_MS, useOpening } from '../opening';

const strict = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;

describe('Today’s opening lights every new paper, and finishes', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  test('it waits for the plate, then lights one by one to the last', () => {
    const { result, rerender } = renderHook(({ total, ready }) => useOpening(total, ready, false), {
      initialProps: { total: 12, ready: false }, wrapper: strict,
    });
    act(() => { jest.advanceTimersByTime(5_000); });
    expect(result.current).toBe(0);
    rerender({ total: 12, ready: true });
    act(() => { jest.advanceTimersByTime(500); });
    expect(result.current).toBeGreaterThan(0);
    expect(result.current).toBeLessThan(12);
    act(() => { jest.advanceTimersByTime(5_000); });
    expect(result.current).toBe(12);
  });

  test('a read that comes back while it runs does not stop it', () => {
    // Today's cached answer is drawn on arrival and asked for again at once; a
    // new answer mid-opening used to leave every number dim for good.
    const { result, rerender } = renderHook(({ total }) => useOpening(total, true, false), {
      initialProps: { total: 40 }, wrapper: strict,
    });
    act(() => { jest.advanceTimersByTime(600); });
    rerender({ total: 40 });
    rerender({ total: 41 });
    act(() => { jest.advanceTimersByTime(10_000); });
    expect(result.current).toBe(41);
    // Papers that arrive after it are lit at once.
    rerender({ total: 45 });
    expect(result.current).toBe(45);
  });

  test.each([1_000, 10_000])('%i papers light in the same time as a hundred, and then nothing is left running', (total) => {
    const { result } = renderHook(() => useOpening(total, true, false), { wrapper: strict });
    // The plate's settling pause, then half the lighting: partly lit.
    act(() => { jest.advanceTimersByTime(420 + OPENING_MS / 2); });
    expect(result.current).toBeGreaterThan(0);
    expect(result.current).toBeLessThan(total);
    // The rest of the lighting and one frame over: all of them, and no timer
    // left to change the page again.
    act(() => { jest.advanceTimersByTime(OPENING_MS / 2 + 16); });
    expect(result.current).toBe(total);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('a hundred papers or a dozen take no longer than the opening either', () => {
    for (const total of [12, 100, 150]) {
      const { result, unmount } = renderHook(() => useOpening(total, true, false), { wrapper: strict });
      act(() => { jest.advanceTimersByTime(420 + OPENING_MS + 16); });
      expect(result.current).toBe(total);
      unmount();
    }
  });

  test('without motion everything is lit from the start', () => {
    const { result } = renderHook(() => useOpening(9, false, true), { wrapper: strict });
    expect(result.current).toBe(9);
  });
});
