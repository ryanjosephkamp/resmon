import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import CoverageSummary from '../components/Results/CoverageSummary';
import { SourceCoverage } from '../api/searchRecord';

const coverage: SourceCoverage = {
  execution_id: 42, basis: 'selected', basis_label: 'selected sources', selection_known: true, total: 3,
  counts: { answered: 1, non_answer: 1, unknown: 1, genuine_empty: 0 },
  summary: '3 selected sources: 1 answered, 1 recorded non-answer, 1 unknown.',
  notes: ['Saved selection', 'Limits stay visible.'], additional_sources: [],
  sources: [{ source: '<img src=x onerror=bad()>', category: 'unknown', label: 'unknown', note: '<script>bad()</script>|# forged',
    result_count: null, recorded_at: null, outcome_recorded: false, genuine_empty: false }],
};
test('backend counts and hostile strings render as text; details opens accessibly', () => {
  const open = jest.fn();
  const { container } = render(<CoverageSummary coverage={coverage} onDetails={open} details />);
  expect(screen.getByText(coverage.summary)).toBeInTheDocument();
  expect(screen.getByText(coverage.sources[0].note)).toBeInTheDocument();
  expect(container.querySelector('script, img')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'View source details' }));
  expect(open).toHaveBeenCalledTimes(1);
});
test('no outcomes uses backend unknown history explanation, never a zero ratio', () => {
  render(<CoverageSummary coverage={{ ...coverage, basis: 'recorded', total: 0, selection_known: false,
    summary: 'No source outcomes were recorded; the full selected set is unknown.', sources: [] }} />);
  expect(screen.getByText(/No source outcomes were recorded/)).toBeInTheDocument();
  expect(screen.queryByText(/0\/0|100%/)).not.toBeInTheDocument();
});
