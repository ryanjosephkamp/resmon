/**
 * Results & Logs page — the post-cloud-removal data path.
 *
 * The page moved from useExecutionsMerged (/api/executions/merged) to
 * useExecutions (/api/executions) when the cloud service was removed. These
 * tests pin that the plain endpoint is what gets called and that the page
 * still renders, selects, and empty-states correctly on top of it.
 */

import React from 'react';
import { fireEvent, screen, waitFor } from '@testing-library/react';
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
  test.each(['BibTeX', 'RIS', 'CSV'])('exports selected runs with one %s request', async (label) => {
    const mock = mockRoutedFetch({ '/api/executions': ROWS, '/api/export/references': 'references' });
    URL.createObjectURL = jest.fn(() => 'blob:continuity');
    URL.revokeObjectURL = jest.fn();
    const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    try {
      await renderWithProviders(<ResultsPage />);
      fireEvent.click(screen.getAllByRole('checkbox')[0]);
      fireEvent.click(screen.getByRole('button', { name: label }));
      await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
      const calls = callsTo(mock, '/api/export/references');
      expect(calls).toHaveLength(1);
      expect(calls[0].init?.method).toBe('POST');
      expect(JSON.parse(String(calls[0].init?.body))).toEqual({
        execution_ids: [11, 12], format: label.toLowerCase(),
      });
      expect(mock.mock.calls.filter(([url]) => /executions\/\d+\/references/.test(String(url)))).toHaveLength(0);
    } finally {
      click.mockRestore();
    }
  });

});
