/**
 * ResultsList — the table itself, as pure props.
 *
 * This component was rebuilt when the cloud service was removed (the Source
 * column, location filter, and read-only cloud rows all came out), so these
 * tests pin what must have survived: rendering, filtering, selection.
 */

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import ResultsList from '../components/Results/ResultsList';

const EXECUTIONS = [
  {
    id: 1, execution_type: 'deep_dive', status: 'completed',
    start_time: '2026-08-19T10:00:00', total_results: 42, new_results: 7,
    keywords: ['cardiac', 'regeneration'], repositories: ['arxiv'],
  },
  {
    id: 2, execution_type: 'deep_sweep', status: 'failed',
    start_time: '2026-08-19T11:00:00', total_results: 0, new_results: 0,
    query: 'lipid nanoparticles', repositories: ['arxiv', 'biorxiv'],
  },
  {
    id: 3, execution_type: 'routine', status: 'completed',
    start_time: '2026-08-19T12:00:00', total_results: 12, new_results: 12,
    keywords: ['perovskite'], repositories: ['crossref'],
  },
];

function renderList(overrides: Partial<React.ComponentProps<typeof ResultsList>> = {}) {
  const props: React.ComponentProps<typeof ResultsList> = {
    executions: EXECUTIONS as any,
    selected: new Set<number>(),
    onToggle: jest.fn(),
    onToggleAll: jest.fn(),
    onRowClick: jest.fn(),
    typeFilter: '',
    statusFilter: '',
    onTypeFilterChange: jest.fn(),
    onStatusFilterChange: jest.fn(),
    ...overrides,
  };
  render(<ResultsList {...props} />);
  return props;
}

describe('ResultsList', () => {
  test('renders one row per execution with type and status badges', () => {
    renderList();
    expect(screen.getByText('Execution #1')).toBeInTheDocument();
    expect(screen.getByText('Execution #2')).toBeInTheDocument();
    expect(screen.getByText('Execution #3')).toBeInTheDocument();
    expect(screen.getByText('deep_dive')).toBeInTheDocument();
    expect(screen.getByText('failed')).toBeInTheDocument();
  });

  test('the cloud-era surface is gone: no Source column, no location chips', () => {
    renderList();
    expect(screen.queryByText('Source')).not.toBeInTheDocument();
    expect(screen.queryByText('Cloud')).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Execution location' })).not.toBeInTheDocument();
  });

  test('type filter narrows the visible rows', () => {
    renderList({ typeFilter: 'deep_dive' });
    expect(screen.getByText('Execution #1')).toBeInTheDocument();
    expect(screen.queryByText('Execution #2')).not.toBeInTheDocument();
    expect(screen.queryByText('Execution #3')).not.toBeInTheDocument();
  });

  test('status filter narrows the visible rows', () => {
    renderList({ statusFilter: 'failed' });
    expect(screen.queryByText('Execution #1')).not.toBeInTheDocument();
    expect(screen.getByText('Execution #2')).toBeInTheDocument();
  });

  test('row click reports the clicked execution', () => {
    const props = renderList();
    fireEvent.click(screen.getByText('Execution #2'));
    expect(props.onRowClick).toHaveBeenCalledWith(
      expect.objectContaining({ id: 2 }),
    );
  });

  test('every row checkbox toggles its own id; header checkbox toggles all', () => {
    const props = renderList();
    const checkboxes = screen.getAllByRole('checkbox');
    // Header + three rows.
    expect(checkboxes).toHaveLength(4);
    fireEvent.click(checkboxes[1]);
    expect(props.onToggle).toHaveBeenCalledWith(1);
    fireEvent.click(checkboxes[0]);
    expect(props.onToggleAll).toHaveBeenCalled();
  });

  test('keywords render joined, with the raw query as fallback', () => {
    renderList();
    expect(screen.getByText('cardiac, regeneration')).toBeInTheDocument();
    // Row 2 has no keywords list; its query string is parsed into terms, so
    // the two unquoted words render comma-joined.
    expect(screen.getByText('lipid, nanoparticles')).toBeInTheDocument();
  });

  test('an empty list says so instead of rendering nothing', () => {
    renderList({ executions: [] });
    expect(screen.getByText('No executions found.')).toBeInTheDocument();
  });
});
