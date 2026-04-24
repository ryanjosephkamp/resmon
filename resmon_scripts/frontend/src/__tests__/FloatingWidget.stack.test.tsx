/**
 * FloatingWidget multi-execution stack spec.
 *
 * Runs under @testing-library/react + jest once a runner is installed.
 * Excluded from tsconfig.json so it does not participate in
 * `npm run build` / `tsc --noEmit`.
 */

import React from 'react';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ExecutionProvider, useExecution } from '../context/ExecutionContext';
import FloatingWidget from '../components/Monitor/FloatingWidget';

beforeEach(() => {
  (global as any).fetch = jest.fn(async (url: string) => {
    const body = url.endsWith('/api/executions/active') ? { active_ids: [] } : {};
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
        <FloatingWidget />
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

describe('FloatingWidget — stacked display', () => {
  test('single execution renders without the stack strip', () => {
    const { getCtx } = setup();
    act(() => {
      getCtx().startExecution(1, 'deep_dive', ['pubmed']);
    });
    expect(screen.queryByTestId('fw-stack-more')).toBeNull();
  });

  test('two executions render a "+1 more" affordance; the popover chip swaps focus', () => {
    const { getCtx } = setup();
    act(() => {
      getCtx().startExecution(1, 'deep_dive', ['pubmed']);
      getCtx().startExecution(2, 'deep_sweep', ['arxiv']);
    });

    // Most-recent start is focused.
    expect(getCtx().focusedExecutionId).toBe(2);

    const moreBtn = screen.getByTestId('fw-stack-more');
    expect(moreBtn.textContent).toMatch(/\+1 more/);

    // Clicking the "+N more" affordance opens the popover.
    act(() => {
      fireEvent.click(moreBtn);
    });
    const chip1 = screen.getByTestId('fw-stack-popover-chip-1');
    expect(chip1).toBeTruthy();

    // Clicking the non-focused chip swaps focus.
    act(() => {
      fireEvent.click(chip1);
    });
    expect(getCtx().focusedExecutionId).toBe(1);
  });

  test('three executions show "+2 more" with both non-focused chips in the popover', () => {
    const { getCtx } = setup();
    act(() => {
      getCtx().startExecution(1, 'deep_dive', ['pubmed']);
      getCtx().startExecution(2, 'deep_sweep', ['arxiv']);
      getCtx().startExecution(3, 'automated_sweep', ['crossref']);
    });
    const moreBtn = screen.getByTestId('fw-stack-more');
    expect(moreBtn.textContent).toMatch(/\+2 more/);

    act(() => {
      fireEvent.click(moreBtn);
    });
    expect(screen.getByTestId('fw-stack-popover-chip-1')).toBeTruthy();
    expect(screen.getByTestId('fw-stack-popover-chip-2')).toBeTruthy();
  });
});
