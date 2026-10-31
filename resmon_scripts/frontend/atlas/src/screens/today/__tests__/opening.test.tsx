import { StrictMode, type ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { OPENING_MS, lightsAt, litAt, nextLightAt, useOpening, type Opening } from '../opening';

const strict = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;
const SETTLE = 420;
const at = (start: number): Opening => ({ state: 'running', start });

describe('Today’s opening starts once, when the plate and the papers are in', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  test('it waits for the plate, then runs from that moment, and once per visit', () => {
    const { result, rerender } = renderHook(({ ready }) => useOpening(ready, false), {
      initialProps: { ready: false }, wrapper: strict,
    });
    act(() => { jest.advanceTimersByTime(5_000); });
    expect(result.current).toEqual({ state: 'waiting' });
    rerender({ ready: true });
    act(() => { jest.advanceTimersByTime(1); });
    expect(result.current.state).toBe('running');
    const first = result.current;
    // The plate going and coming back (a refit) does not start it again.
    rerender({ ready: false });
    rerender({ ready: true });
    act(() => { jest.advanceTimersByTime(1); });
    expect(result.current).toBe(first);
  });

  test('without motion there is no opening: everything is lit from the start', () => {
    const { result } = renderHook(() => useOpening(false, true), { wrapper: strict });
    expect(result.current).toEqual({ state: 'none' });
    expect(litAt(result.current, 9, 0)).toBe(9);
  });
});

describe('the schedule: every paper lit within the opening, at any count', () => {
  test.each([1_000, 10_000])('%i papers: partly lit halfway, all lit at the end, and nothing left to wake for', (total) => {
    expect(litAt(at(0), total, SETTLE - 1)).toBe(0);
    const half = litAt(at(0), total, SETTLE + OPENING_MS / 2);
    expect(half).toBeGreaterThan(0);
    expect(half).toBeLessThan(total);
    expect(litAt(at(0), total, SETTLE + OPENING_MS)).toBe(total);
    expect(nextLightAt(at(0), total, SETTLE + OPENING_MS)).toBeNull();
    expect(lightsAt(total, total)).toBeLessThanOrEqual(SETTLE + OPENING_MS);
  });

  test('a dozen light one at a time, a pause apart; a hundred and more within the same time', () => {
    expect(lightsAt(2, 12) - lightsAt(1, 12)).toBe(90);
    for (const total of [12, 100, 150]) expect(litAt(at(0), total, SETTLE + OPENING_MS)).toBe(total);
  });

  test('the next wake is the next paper’s turn, in order', () => {
    const start = 1_000;
    expect(nextLightAt(at(start), 40, start)).toBe(start + lightsAt(1, 40));
    expect(nextLightAt(at(start), 40, start + lightsAt(1, 40))).toBe(start + lightsAt(2, 40));
  });

  test('a read that adds papers while it runs only moves the schedule; it still ends in time', () => {
    // Today's cached answer is drawn on arrival and asked for again at once.
    const opening = at(0);
    expect(litAt(opening, 40, SETTLE + 500)).toBeLessThan(40);
    expect(litAt(opening, 45, SETTLE + OPENING_MS)).toBe(45);
  });

  test('before the plate is in, none is lit; without an opening, all are', () => {
    expect(litAt({ state: 'waiting' }, 30, 10_000)).toBe(0);
    expect(nextLightAt({ state: 'waiting' }, 30, 0)).toBeNull();
    expect(litAt({ state: 'none' }, 30, 0)).toBe(30);
  });
});
