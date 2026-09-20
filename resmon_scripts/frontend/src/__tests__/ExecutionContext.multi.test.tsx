/**
 * Multi-execution ExecutionContext spec.
 *
 * NOTE: The frontend does not yet ship a test runner. This file is authored
 * against @testing-library/react + jest so that once a runner is wired up in
 * a later step, it executes as-is. It is excluded from the tsconfig.json
 * include set so it does not participate in `npm run build` or typecheck.
 */

import React from 'react';
import { act, render, renderHook, waitFor } from '@testing-library/react';
import { ExecutionProvider, useExecution } from '../context/ExecutionContext';

// Minimal fetch stub so the mount reconnect effect does not explode.
beforeEach(() => {
  (global as any).fetch = jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ active_ids: [] }),
    text: async () => '{}',
  }));
});

afterEach(() => {
  jest.resetAllMocks();
});

const wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <ExecutionProvider>{children}</ExecutionProvider>
);

describe('ExecutionContext (multi-execution)', () => {
  test('a run that leaves the active set as interrupted stops being running', async () => {
    // Schema 19. There is no `interrupted` progress event and there cannot be
    // one -- the process that would have emitted it is what went away -- so
    // this state only ever arrives by reading the row back after the id drops
    // out of /api/executions/active. Before this, the store kept the run at
    // `running` for ever and the widget span over a run that was over.
    let activeIds: number[] = [7];
    (global as any).fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes('/api/executions/active')
        ? { active_ids: activeIds }
        : url.includes('/progress/events')
          ? []
          : { id: 7, execution_type: 'deep_sweep', status: 'interrupted',
              interrupted_reason: 'owner_dead', start_time: '2026-08-19T11:00:00',
              total_results: 0, new_results: 0, routine_id: null };
      return { ok: true, status: 200, headers: { get: () => 'application/json' },
               json: async () => body, text: async () => JSON.stringify(body) };
    });

    const { result } = renderHook(() => useExecution(), { wrapper });
    act(() => { result.current.startExecution(7, 'deep_sweep', ['arxiv']); });
    expect(result.current.hasAnyRunning).toBe(true);

    activeIds = [];
    // Real timers: the active poller owns a 3 s interval and this is the one
    // case in the file that depends on it actually firing.
    await waitFor(
      () => expect(result.current.activeExecutions[7]?.status).toBe('interrupted'),
      { timeout: 8000, interval: 50 },
    );
    expect(result.current.hasAnyRunning).toBe(false);
  });

  test('tracks multiple concurrent executions and orders them by start', () => {
    const { result } = renderHook(() => useExecution(), { wrapper });

    act(() => {
      result.current.startExecution(1, 'deep_dive', ['pubmed']);
    });
    act(() => {
      result.current.startExecution(2, 'deep_sweep', ['arxiv']);
    });

    expect(result.current.executionOrder).toEqual([1, 2]);
    expect(result.current.focusedExecutionId).toBe(2);
    expect(result.current.activeExecutions[1]?.executionType).toBe('deep_dive');
    expect(result.current.activeExecutions[2]?.executionType).toBe('deep_sweep');
    // Backward-compatible alias mirrors the focused execution.
    expect(result.current.activeExecution?.executionId).toBe(2);
    expect(result.current.hasAnyRunning).toBe(true);
  });

  test('focusExecution swaps the focused id without mutating the store', () => {
    const { result } = renderHook(() => useExecution(), { wrapper });

    act(() => {
      result.current.startExecution(1, 'deep_dive', ['pubmed']);
      result.current.startExecution(2, 'deep_sweep', ['arxiv']);
    });

    act(() => {
      result.current.focusExecution(1);
    });

    expect(result.current.focusedExecutionId).toBe(1);
    expect(result.current.activeExecution?.executionId).toBe(1);
    expect(Object.keys(result.current.activeExecutions).sort()).toEqual(['1', '2']);
  });

  test('clearExecution removes only the targeted id', () => {
    const { result } = renderHook(() => useExecution(), { wrapper });

    act(() => {
      result.current.startExecution(1, 'deep_dive', ['pubmed']);
      result.current.startExecution(2, 'deep_sweep', ['arxiv']);
    });

    act(() => {
      result.current.clearExecution(1);
    });

    expect(result.current.executionOrder).toEqual([2]);
    expect(result.current.activeExecutions[1]).toBeUndefined();
    expect(result.current.activeExecutions[2]).toBeDefined();
    expect(result.current.focusedExecutionId).toBe(2);
  });

  test('clearExecution() with no argument falls back to the focused id', () => {
    const { result } = renderHook(() => useExecution(), { wrapper });

    act(() => {
      result.current.startExecution(1, 'deep_dive', ['pubmed']);
      result.current.startExecution(2, 'deep_sweep', ['arxiv']);
    });

    act(() => {
      result.current.clearExecution();
    });

    expect(result.current.activeExecutions[2]).toBeUndefined();
    expect(result.current.executionOrder).toEqual([1]);
    expect(result.current.focusedExecutionId).toBe(1);
  });

  test('startExecution dispatches resmon:execution-started CustomEvent', () => {
    const listener = jest.fn();
    window.addEventListener('resmon:execution-started', listener as EventListener);

    const { result } = renderHook(() => useExecution(), { wrapper });
    act(() => {
      result.current.startExecution(7, 'automated_sweep', ['pubmed']);
    });

    expect(listener).toHaveBeenCalled();
    const detail = (listener.mock.calls[0][0] as CustomEvent).detail;
    expect(detail.executionId).toBe(7);
    expect(detail.executionType).toBe('automated_sweep');

    window.removeEventListener('resmon:execution-started', listener as EventListener);
  });

  test('provider smoke renders children', () => {
    const { container } = render(
      <ExecutionProvider>
        <div data-testid="child">ok</div>
      </ExecutionProvider>,
    );
    expect(container.querySelector('[data-testid="child"]')?.textContent).toBe('ok');
  });
});
