/**
 * Results & Logs page — the post-cloud-removal data path.
 *
 * The page moved from useExecutionsMerged (/api/executions/merged) to
 * useExecutions (/api/executions) when the cloud service was removed. These
 * tests pin that the plain endpoint is what gets called and that the page
 * still renders, selects, and empty-states correctly on top of it.
 */

import React from 'react';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
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

const INTERRUPTED = {
  id: 13, execution_type: 'deep_sweep', status: 'interrupted',
  interrupted_reason: 'owner_dead', last_seen_at_utc: '2026-08-19T11:42:00+00:00',
  start_time: '2026-08-19T11:00:00', total_results: 0, new_results: 0,
  keywords: ['lattice'], repositories: ['arxiv'],
};

describe('ResultsPage', () => {
  test('an interrupted row says why and offers Restart, which posts and follows it', async () => {
    // Schema 19. The row a force-quit leaves: the reason resmon can establish
    // and the last moment it saw the run working, in words rather than a
    // status code -- and the one action that is actually available from there.
    const restarts: string[] = [];
    mockRoutedFetch({
      '/api/executions': [...ROWS, INTERRUPTED],
      '/api/executions/13/restart': (url: string) => {
        restarts.push(url);
        return { execution_id: 99, restarted_from: 13, ai_enabled: false };
      },
      '/api/executions/99': { id: 99, execution_type: 'deep_sweep', status: 'running',
                              start_time: '2026-08-19T11:45:00', routine_id: null },
    });
    await renderWithProviders(<ResultsPage />);

    const note = await screen.findByTestId('interrupted-note-13');
    expect(note.textContent).toContain('the process running it stopped');
    expect(note.textContent).toContain('2026-08-19 11:42');

    // Only the stopped row offers it; the two completed rows do not.
    const buttons = screen.getAllByRole('button', { name: 'Restart' });
    expect(buttons).toHaveLength(1);

    await act(async () => { fireEvent.click(buttons[0]); });
    await waitFor(() => expect(restarts.length).toBe(1));
    expect(restarts[0]).toContain('/api/executions/13/restart');
    await waitFor(() => expect(window.location.hash).toBe('#/monitor'));
  });

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

  test.each([
    ['stale execution', { detail: 'Execution 777 not found' }, 'Reference export failed (HTTP 404): Execution 777 not found'],
    ['malformed JSON', new SyntaxError('invalid JSON'), 'Reference export failed (HTTP 404)'],
    ['non-JSON response', new SyntaxError('<html>not JSON</html>'), 'Reference export failed (HTTP 404)'],
    ['non-string detail', { detail: [{ msg: 'validation error' }] }, 'Reference export failed (HTTP 404)'],
    ['empty detail', { detail: '   ' }, 'Reference export failed (HTTP 404)'],
  ])('shows a useful export error for %s', async (_label, payload, expected) => {
    const mock = mockRoutedFetch({ '/api/executions': ROWS });
    const routed = mock.getMockImplementation()!;
    mock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/api/export/references')) return {
        ok: false, status: 404,
        json: async () => { if (payload instanceof Error) throw payload; return payload; },
      };
      return routed(input, init);
    });
    await renderWithProviders(<ResultsPage />);
    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    fireEvent.click(screen.getByRole('button', { name: 'BibTeX' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(String(expected)));
  });

});
