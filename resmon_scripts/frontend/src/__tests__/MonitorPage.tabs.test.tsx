/**
 * Monitor tab-strip spec.
 *
 * Like ExecutionContext.multi.test.tsx this file is authored against
 * @testing-library/react + jest so it runs as-is once a runner is added.
 * It is excluded from tsconfig.json so it does not participate in
 * `npm run build` / `tsc --noEmit`.
 */

import React from 'react';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ExecutionProvider, useExecution } from '../context/ExecutionContext';
import MonitorPage from '../pages/MonitorPage';

beforeEach(() => {
  (global as any).fetch = jest.fn(async (url: string) => {
    const body =
      url.endsWith('/api/routines') ? [] :
      url.endsWith('/api/executions/active') ? { active_ids: [] } :
      {};
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  });
});

afterEach(() => {
  jest.resetAllMocks();
});

/** Utility: mount MonitorPage + expose the context so tests can seed executions. */
function setup() {
  let ctxHandle: ReturnType<typeof useExecution> | null = null;
  const Probe: React.FC = () => {
    ctxHandle = useExecution();
    return null;
  };
  const utils = render(
    <MemoryRouter>
      <ExecutionProvider>
        <Probe />
        <MonitorPage />
      </ExecutionProvider>
    </MemoryRouter>,
  );
  return {
    ...utils,
    getCtx: () => {
      if (!ctxHandle) throw new Error('context not ready');
      return ctxHandle;
    },
  };
}

describe('MonitorPage — multi-execution tab strip', () => {
  test('renders the empty-state copy when no executions are active', () => {
    render(
      <MemoryRouter>
        <ExecutionProvider>
          <MonitorPage />
        </ExecutionProvider>
      </MemoryRouter>,
    );
    expect(screen.getByText(/No active executions/i)).toBeTruthy();
    expect(
      screen.getByText(/wait for a scheduled routine to fire/i),
    ).toBeTruthy();
  });

  test('renders one tab row per active execution', () => {
    const { getCtx, getByTestId } = setup();
    act(() => {
      getCtx().startExecution(1, 'deep_dive', ['pubmed']);
      getCtx().startExecution(2, 'deep_sweep', ['arxiv']);
    });
    expect(getByTestId('mon-tab-1')).toBeTruthy();
    expect(getByTestId('mon-tab-2')).toBeTruthy();
  });

  test('clicking row 1 focuses execution 1 and surfaces its detail pane', () => {
    const { getCtx, getByTestId } = setup();
    act(() => {
      getCtx().startExecution(1, 'deep_dive', ['pubmed']);
      getCtx().startExecution(2, 'deep_sweep', ['arxiv']);
    });

    // By default the most recent start is focused.
    expect(getCtx().focusedExecutionId).toBe(2);

    act(() => {
      fireEvent.click(getByTestId('mon-tab-1'));
    });
    expect(getCtx().focusedExecutionId).toBe(1);

    // ExecutionHeader renders "Execution #<id>" — confirm the right pane now
    // reflects execution 1 rather than execution 2.
    expect(screen.getByText(/Execution #1/)).toBeTruthy();
    expect(screen.queryByText(/Execution #2/)).toBeNull();
  });

  test('close button is disabled while an execution is still running', () => {
    const { getCtx, getByTestId } = setup();
    act(() => {
      getCtx().startExecution(1, 'deep_dive', ['pubmed']);
    });
    const row = getByTestId('mon-tab-1');
    const closeBtn = row.querySelector('.mon-tab-close') as HTMLButtonElement;
    expect(closeBtn.disabled).toBe(true);
  });
});
