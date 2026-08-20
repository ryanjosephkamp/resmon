/**
 * Results & Logs page — the post-cloud-removal data path.
 *
 * The page moved from useExecutionsMerged (/api/executions/merged) to
 * useExecutions (/api/executions) when the cloud service was removed. These
 * tests pin that the plain endpoint is what gets called and that the page
 * still renders, selects, and empty-states correctly on top of it.
 */

import React from 'react';
import { fireEvent, screen } from '@testing-library/react';
import ResultsPage from '../pages/ResultsPage';
import { callsTo, mockRoutedFetch, renderWithProviders } from './testUtils';

const ROWS = [
  {
    id: 11, execution_type: 'deep_dive', status: 'completed',
    start_time: '2026-08-19T09:00:00', total_results: 5, new_results: 5,
    keywords: ['graphene'], repositories: ['arxiv'],
  },
  {
    id: 12, execution_type: 'routine', status: 'completed',
    start_time: '2026-08-19T10:00:00', total_results: 9, new_results: 2,
    keywords: ['fusion'], repositories: ['crossref'],
  },
];

describe('ResultsPage', () => {
  test('fetches /api/executions (not the retired merged endpoint) and renders rows', async () => {
    const mock = mockRoutedFetch({ '/api/executions': ROWS });
    await renderWithProviders(<ResultsPage />);

    expect(screen.getByText('Execution #11')).toBeInTheDocument();
    expect(screen.getByText('Execution #12')).toBeInTheDocument();

    expect(callsTo(mock, '/api/executions?').length).toBeGreaterThan(0);
    expect(callsTo(mock, '/api/executions/merged')).toHaveLength(0);
  });

  test('an empty history renders the empty state, not an error', async () => {
    mockRoutedFetch({ '/api/executions': [] });
    await renderWithProviders(<ResultsPage />);
    expect(screen.getByText('No executions found.')).toBeInTheDocument();
  });

  test('select-all marks every row selected', async () => {
    mockRoutedFetch({ '/api/executions': ROWS });
    await renderWithProviders(<ResultsPage />);

    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[0]); // header select-all
    for (const box of screen.getAllByRole('checkbox')) {
      expect(box).toBeChecked();
    }
  });

  test('the location filter from the cloud era is gone', async () => {
    mockRoutedFetch({ '/api/executions': ROWS });
    await renderWithProviders(<ResultsPage />);
    expect(screen.queryByText('Cloud')).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Execution location' })).not.toBeInTheDocument();
  });
});
