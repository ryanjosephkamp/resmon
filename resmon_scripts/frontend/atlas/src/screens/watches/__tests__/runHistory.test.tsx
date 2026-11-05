/**
 * A watch's runs say nothing final about a run still going: its counts so far
 * are not what it brought in.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { components } from '../../../api/schema';
import { RunHistory } from '../RunHistory';

type RunRow = components['schemas']['RunRow'];

const now = new Date('2026-10-31T18:00:00Z');

function run(id: number, status: string, newCount: number | null, found: number | null = newCount): RunRow {
  return {
    id, status, new_result_count: newCount, result_count: found,
    start_time: '2026-10-31 17:00:00', end_time: status === 'running' ? null : '2026-10-31 17:00:05',
    execution_type: 'automated_sweep', routine_id: 7,
  } as unknown as RunRow;
}

function shown(runs: RunRow[]) {
  render(<MemoryRouter><RunHistory runs={runs} now={now} names={new Map()} /></MemoryRouter>);
  return document.querySelector('.night-scale')?.textContent ?? '';
}

test('a first run still going is not said to have brought in nothing', () => {
  const line = shown([run(3, 'running', 0)]);
  expect(line).toBe('This run is still going: what it brought in is said when it ends.');
  expect(line).not.toMatch(/no new paper/);
  expect(screen.getByText('counted when it ends')).toBeTruthy();
});

test('finished runs are stated, and the one still going is counted when it ends', () => {
  expect(shown([run(5, 'running', 0), run(4, 'completed', 0), run(3, 'completed', 0)]))
    .toBe('None of the 2 finished runs brought in a new paper. The run still going is counted when it ends.');
});

test('a tallest bar is taken from finished runs only', () => {
  const line = shown([run(5, 'running', 40), run(4, 'completed', 3), run(3, 'completed', 2)]);
  expect(line).toContain('the tallest bar is 3 papers.');
  expect(line).toContain('The run still going is counted when it ends.');
});

test('with nothing going, the sentences are as before', () => {
  expect(shown([run(4, 'completed', 0)])).toBe('This run brought in no new paper.');
});

if (!('PointerEvent' in window)) {
  class PointerEventShim extends MouseEvent {}
  Object.defineProperty(window, 'PointerEvent', { value: PointerEventShim, configurable: true });
}

describe('the strip\'s bars', () => {
  const runs = () => [
    { ...run(9, 'completed', 2, 40), source_outcomes: { could_not_answer: 1, sources_that_could_not_answer: ['crossref'] } },
    run(8, 'completed', null, null),
    run(7, 'failed', 0, 0),
  ] as RunRow[];

  test('each bar opens its run, and the strip is one stop with the newest run first to the keyboard', () => {
    render(<MemoryRouter><RunHistory runs={runs()} now={now} names={new Map([['crossref', 'Crossref']])} /></MemoryRouter>);
    const strip = screen.getByRole('group', { name: 'Papers new in each of the last 3 runs, oldest first' });
    const bars = within(strip).getAllByRole('link');
    expect(bars.map((b) => b.getAttribute('href'))).toEqual(['/runs/7', '/runs/8', '/runs/9']);
    expect(bars.map((b) => b.tabIndex)).toEqual([-1, -1, 0]);
    act(() => bars[2]!.focus());
    expect(screen.getByRole('tooltip')).toHaveTextContent('2 new papers');
    expect(screen.getByRole('tooltip')).toHaveTextContent('40 found in all');
    expect(screen.getByRole('tooltip')).toHaveTextContent('Crossref did not answer.');
    expect(screen.getByRole('tooltip').querySelector('.chart-tip-opens')?.textContent).toBe('Opens run 9');
    fireEvent.keyDown(bars[2]!, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(bars[1]);
  });

  test('a count the run did not record is said so, never as none, and a failed run says it failed', () => {
    render(<MemoryRouter><RunHistory runs={runs()} now={now} names={new Map()} /></MemoryRouter>);
    const [failed, unrecorded] = within(screen.getByRole('group')).getAllByRole('link');
    expect(unrecorded).toHaveAccessibleName(/^Run 8 · .*: New papers not recorded\. Opens run 8\.$/);
    // Drawn as a mark of its own, never as a bar of none.
    expect(unrecorded).toHaveAttribute('data-unrecorded', 'true');
    expect(unrecorded!.querySelector<HTMLElement>('.night-amount')?.style.height).toBe('');
    expect(failed).not.toHaveAttribute('data-unrecorded');
    fireEvent.pointerEnter(failed!, { clientX: 20, clientY: 300 });
    expect(screen.getByRole('tooltip')).toHaveTextContent('The run failed.');
  });
});
