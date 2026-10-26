/**
 * The Monitor's stage list says how far a run got, not that it finished.
 *
 * It used to tick every stage for any status but 'running', so a run cancelled
 * during Query -- and a run still cancelling -- showed Normalize through
 * Finalize as done. Found in a walk of the app on October 26, 2026.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import PipelineStages from '../components/Monitor/PipelineStages';
import type { ActiveExecution } from '../context/ExecutionContext';

function exec(status: ActiveExecution['status'], currentStage?: string): ActiveExecution {
  return {
    executionId: 140, executionType: 'deep_dive', repositories: ['biorxiv'],
    startTime: '2026-10-26T18:15:00Z', events: [], status, currentStage,
    resultCount: 0, newCount: 0,
  } as unknown as ActiveExecution;
}

const states = () => Object.fromEntries(
  ['init', 'querying', 'normalizing', 'dedup', 'linking', 'reporting', 'summarizing', 'finalizing']
    .map((key) => [key, screen.getByTestId(`stage-${key}`).getAttribute('data-state')]),
);

test('a run cancelled during Query stopped there, and never reached the rest', () => {
  render(<PipelineStages exec={exec('cancelled', 'querying')} aiEnabled={false} />);
  expect(states()).toEqual({
    init: 'done', querying: 'stopped', normalizing: 'not-run', dedup: 'not-run',
    linking: 'not-run', reporting: 'not-run', summarizing: 'not-run', finalizing: 'not-run',
  });
  expect(screen.getByTestId('stage-querying')).toHaveAttribute(
    'title', 'The run stopped here (cancelled)');
});

test('a run still cancelling is still in its stage, with nothing after it done', () => {
  render(<PipelineStages exec={exec('cancelling', 'querying')} aiEnabled={false} />);
  const s = states();
  expect(s.querying).toBe('active');
  expect(s.finalizing).toBe('future');
  expect(Object.values(s)).not.toContain('stopped');
});

test('a failed run stops in the stage that failed', () => {
  render(<PipelineStages exec={exec('failed', 'reporting')} aiEnabled />);
  const s = states();
  expect([s.init, s.querying, s.normalizing, s.dedup, s.linking]).toEqual(
    ['done', 'done', 'done', 'done', 'done']);
  expect(s.reporting).toBe('stopped');
  expect([s.summarizing, s.finalizing]).toEqual(['not-run', 'not-run']);
});

test('only a completed run passed every stage', () => {
  render(<PipelineStages exec={exec('completed', 'finalizing')} aiEnabled={false} />);
  const s = states();
  expect(s.summarizing).toBe('skipped');
  expect(Object.entries(s).filter(([k]) => k !== 'summarizing').map(([, v]) => v))
    .toEqual(Array(7).fill('done'));
});
