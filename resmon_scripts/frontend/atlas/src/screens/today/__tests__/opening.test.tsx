import { StrictMode, type ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import {
  OPENING_MS, answerKey, forgetOpenings, lightsAt, litAt, nextLightAt, useOpening, type Opening,
} from '../opening';

const strict = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;
const SETTLE = 420;
const at = (start: number): Opening => ({ state: 'running', start });

describe('Today’s opening plays once for each new answer, when the plate and the papers are in', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    forgetOpenings();
  });
  afterEach(() => { jest.useRealTimers(); });

  const visit = (answer: string | null) => renderHook(({ key }) => useOpening(key, false), {
    initialProps: { key: answer }, wrapper: strict,
  });

  test('it waits for the plate, then runs from that moment, once', () => {
    const { result, rerender } = visit(null);
    act(() => { jest.advanceTimersByTime(5_000); });
    expect(result.current).toEqual({ state: 'waiting' });
    rerender({ key: '41@2026-11-01 06:00:00' });
    act(() => { jest.advanceTimersByTime(1); });
    expect(result.current.state).toBe('running');
    const first = result.current;
    // The plate going and coming back (a refit) does not start it again.
    rerender({ key: null });
    rerender({ key: '41@2026-11-01 06:00:00' });
    act(() => { jest.advanceTimersByTime(1); });
    expect(result.current).toBe(first);
  });

  test('a return to the same answer draws it at rest at once; a newer one plays it again', () => {
    const first = visit('41@2026-11-01 06:00:00');
    act(() => { jest.advanceTimersByTime(1); });
    expect(first.result.current.state).toBe('running');
    first.unmount();

    // Back on Today, the same answer: lit from the first frame, with nothing to wait for.
    const again = visit('41@2026-11-01 06:00:00');
    expect(again.result.current).toEqual({ state: 'none' });
    act(() => { jest.advanceTimersByTime(5_000); });
    expect(again.result.current).toEqual({ state: 'none' });

    // A run brought a newer arrival while Today was open: it plays for that answer.
    again.rerender({ key: '57@2026-11-01 07:30:00' });
    act(() => { jest.advanceTimersByTime(1); });
    expect(again.result.current.state).toBe('running');
    again.unmount();
    expect(visit('57@2026-11-01 07:30:00').result.current).toEqual({ state: 'none' });
  });

  test('an answer that arrives while it runs joins it, and is not played again later', () => {
    const { result, rerender, unmount } = visit('41@a');
    act(() => { jest.advanceTimersByTime(1); });
    const running = result.current;
    rerender({ key: '42@b' });
    act(() => { jest.advanceTimersByTime(1); });
    expect(result.current).toBe(running);
    unmount();
    expect(visit('42@b').result.current).toEqual({ state: 'none' });
  });

  test('an answer is its newest arrival, not the read that brought it', () => {
    expect(answerKey({ id: 41, first_seen_at: '2026-11-01 06:00:00' })).toBe('41@2026-11-01 06:00:00');
    expect(answerKey(undefined)).toBe('none');
  });

  test('without motion there is no opening: everything is lit from the start', () => {
    const { result } = renderHook(() => useOpening('41@a', true), { wrapper: strict });
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
