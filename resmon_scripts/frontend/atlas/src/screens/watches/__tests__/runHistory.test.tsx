/**
 * A watch's runs say nothing final about a run still going: its counts so far
 * are not what it brought in.
 */
import { render, screen } from '@testing-library/react';
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
