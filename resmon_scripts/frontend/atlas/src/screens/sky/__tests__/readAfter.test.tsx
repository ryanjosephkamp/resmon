import { act, renderHook } from '@testing-library/react';
import type { UseQueryResult } from '@tanstack/react-query';
import { useReadAfter } from '../readAfter';

/** A map query as far as the hook reads one: its data, when it came back, and a way to ask again. */
function query(updatedAt: number, refetch: () => Promise<unknown>): UseQueryResult<unknown> {
  return { data: { state: 'ready' }, dataUpdatedAt: updatedAt, refetch } as unknown as UseQueryResult<unknown>;
}

const END = '2026-10-30T23:47:17Z';
const end = Date.parse(END);

describe('a map is trusted for a run once it has been read since the run ended', () => {
  test('with no moment to be read after, the map in hand is current and nothing is asked', () => {
    const refetch = jest.fn(() => Promise.resolve());
    const { result } = renderHook(() => useReadAfter(query(end - 60_000, refetch), null));
    expect(result.current).toBe(true);
    expect(refetch).not.toHaveBeenCalled();
  });

  test('a read that finished just after the end may have begun before it, so it is asked for again', async () => {
    let finish: () => void = () => {};
    const refetch = jest.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const { result } = renderHook(() => useReadAfter(query(end + 400, refetch), END));
    expect(result.current).toBe(false);
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(refetch).toHaveBeenCalledWith({ cancelRefetch: true });
    await act(async () => { finish(); });
    expect(result.current).toBe(true);
  });

  test('a read from before the end is asked for again once, however often it draws', async () => {
    const refetch = jest.fn(() => Promise.resolve());
    const { result, rerender } = renderHook(() => useReadAfter(query(end - 5_000, refetch), END));
    rerender();
    rerender();
    await act(async () => {});
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(result.current).toBe(true);
  });

  test('a read that finished well after the end is trusted as it is', () => {
    const refetch = jest.fn(() => Promise.resolve());
    const { result } = renderHook(() => useReadAfter(query(end + 120_000, refetch), END));
    expect(result.current).toBe(true);
    expect(refetch).not.toHaveBeenCalled();
  });
});
