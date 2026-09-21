/**
 * Results reads its statuses from the one vocabulary, not from two lists of
 * its own.
 *
 * `ExecutionStatusVocabulary.test.ts` already pins `EXECUTION_DB_STATUSES` to
 * the `executions.status` CHECK in `database.py`. What that cannot say is
 * whether the Results page *uses* it: the filter's options and the set of rows
 * that offer a Restart button were both hand-written here, so a status added
 * to the schema and to the vocabulary would still have arrived in a table it
 * could not be filtered by.
 *
 * The named mutation for this file: add a status to `EXECUTION_DB_STATUSES`
 * and the first case below goes red unless the filter grew an option for it.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import ResultsList from '../components/Results/ResultsList';
import {
  EXECUTION_DB_STATUSES,
  RESTARTABLE_STATUSES,
  executionStatusLabel,
} from '../context/executionStatus';

const EXECUTIONS = EXECUTION_DB_STATUSES.map((status, index) => ({
  id: index + 1,
  execution_type: 'deep_dive',
  status,
  start_time: '2026-09-20T10:00:00',
  total_results: 0,
  new_results: 0,
  query: 'perovskite',
  repositories: ['arxiv'],
}));

function renderList(overrides: Partial<React.ComponentProps<typeof ResultsList>> = {}) {
  render(
    <ResultsList
      executions={EXECUTIONS as any}
      selected={new Set<number>()}
      onToggle={jest.fn()}
      onToggleAll={jest.fn()}
      onRowClick={jest.fn()}
      typeFilter=""
      statusFilter=""
      onTypeFilterChange={jest.fn()}
      onStatusFilterChange={jest.fn()}
      {...overrides}
    />,
  );
}

describe('the Results status filter follows the vocabulary', () => {
  test('every stored status has an option, and nothing else does', () => {
    renderList();
    // Two comboboxes on this page — type, then status.
    const selects = screen.getAllByRole('combobox') as HTMLSelectElement[];
    expect(selects).toHaveLength(2);
    const status = selects[1];
    const values = Array.from(status.options).map((o) => o.value);
    // The empty value is "All Statuses" and belongs to the filter, not to the
    // vocabulary.
    expect(values).toEqual(['', ...EXECUTION_DB_STATUSES]);
    for (const value of EXECUTION_DB_STATUSES) {
      expect(
        Array.from(status.options).find((o) => o.value === value)?.text,
      ).toBe(executionStatusLabel(value));
    }
  });

  test('Restart is offered on exactly the restartable statuses', () => {
    renderList({ onRestart: jest.fn() });
    const restartable = new Set<string>(RESTARTABLE_STATUSES);
    for (const execution of EXECUTIONS) {
      const button = screen.queryByTestId(`restart-${execution.id}`);
      if (restartable.has(execution.status)) {
        expect(button).toBeInTheDocument();
      } else {
        expect(button).not.toBeInTheDocument();
      }
    }
    // And the derivation says what the backend says, spelled out once here so
    // the mirror of ``resmon._RESTARTABLE_STATES`` is visible to a reader.
    expect([...RESTARTABLE_STATUSES].sort())
      .toEqual(['cancelled', 'failed', 'interrupted']);
  });
});
