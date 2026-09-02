/**
 * The search record — the labeling, not the layout.
 *
 * A methods section built on a mislabelled figure is worse than no record,
 * because a reviewer will publish it. The interface is where the labeling is
 * most easily lost: a tidy table under PRISMA headings, with the meanings
 * tucked behind a "details" toggle, would let a reader take the numbers and
 * leave the qualifications behind.
 *
 * So: the meanings and caveats render in the same panel as the numbers, "not
 * recorded" never renders as 0, and the one figure with no PRISMA box says so
 * in the table rather than borrowing a neighbour's.
 */

import React from 'react';
import { act, render, screen } from '@testing-library/react';
import SearchRecord from '../components/Results/SearchRecord';

const RECORD = {
  generated_at: '2026-08-20T12:00:00Z',
  software: { name: 'resmon', version: '1.6.1', citation: 'resmon 1.6.1' },
  search: {
    execution_id: 42,
    run_at: '2026-07-01T09:00:00Z',
    completed_at: '2026-07-01T09:04:00Z',
    status: 'completed',
    keywords: ['cardiac', 'transformer'],
    query_as_sent: 'cardiac transformer',
    date_from: '2026-01-01',
    date_to: '2026-06-30',
    max_results_per_source: 100,
    routine_name: 'Weekly cardiac',
    routine_schedule: '0 6 * * 1',
    configuration_name: null,
  },
  sources: [
    { source: 'arxiv', records_identified: 120, status: 'ok', note: null },
    { source: 'pubmed', records_identified: 64, status: 'ok', note: null },
    {
      source: 'nasa_ads', records_identified: 0, status: 'skipped_missing_key',
      note: 'Selected, but the API key it requires was not configured, so this '
        + 'source returned nothing. It did not contribute to the search.',
    },
  ],
  identification: {
    records_identified: 184,
    sources_searched: 3,
    sources_that_answered: 2,
    prisma: 'Records identified from databases',
  },
  deduplication: {
    records_processed: 184,
    cross_source_duplicates: {
      count: 8,
      recorded: true,
      prisma: 'Duplicate records removed before screening',
      meaning: 'Records identified as the same paper as a record from a different '
        + 'source. resmon flags these and keeps both rows — it does not remove '
        + 'either, so this is a count of duplicates found, not of duplicates deleted.',
      not_recorded_reason: null,
    },
    already_held: {
      count: 22,
      prisma: null,
      meaning: 'Records this search returned that were already in the corpus from '
        + 'an earlier run. This has no equivalent in a PRISMA flow diagram.',
    },
    discarded_unusable: {
      count: 4,
      prisma: 'Records marked as ineligible by automation tools',
      meaning: 'Records discarded because they lacked a title or a usable '
        + 'identifier. This is a data-quality discard, not a relevance judgement.',
    },
    records_added: {
      count: 150,
      prisma: 'Records screened',
      meaning: 'Records newly added to the corpus by this search.',
    },
  },
  caveats: [
    'resmon retains cross-source duplicates rather than removing them.',
    'This record covers one execution.',
    'resmon does not record screening decisions.',
  ],
};

function mockFetch(payload: unknown) {
  (global as any).fetch = jest.fn(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }));
}

async function renderRecord(payload: unknown = RECORD) {
  mockFetch(payload);
  await act(async () => { render(<SearchRecord executionId={42} />); });
}

describe('SearchRecord', () => {
  test('per-database counts and the total are shown', async () => {
    await renderRecord();

    expect(screen.getByText('arxiv')).toBeInTheDocument();
    expect(screen.getByText('120')).toBeInTheDocument();
    // 184 appears twice by design: as the identified total, and again as the
    // number of records processed. Those are the same figure seen from two
    // stages, and collapsing either away would break the flow diagram.
    expect(screen.getAllByText('184')).toHaveLength(2);
    expect(screen.getByText(/2 of 3 sources answered/)).toBeInTheDocument();
  });

  test('a database that contributed nothing is still listed, with why', async () => {
    // A strategy listing it as searched would overstate its coverage.
    await renderRecord();

    // Twice on purpose: once as a row in the table, once in the notes beneath
    // it explaining why its count is zero.
    expect(screen.getAllByText('nasa_ads')).toHaveLength(2);
    expect(screen.getByText('skipped missing key')).toBeInTheDocument();
    expect(screen.getByText(/did not contribute to the search/)).toBeInTheDocument();
  });

  test('duplicates are labeled as found, never as removed', async () => {
    await renderRecord();

    expect(screen.getByText(/does not remove either/)).toBeInTheDocument();
    expect(screen.getByText(/not of duplicates deleted/)).toBeInTheDocument();
  });

  test('the figure with no PRISMA box says so rather than borrowing one', async () => {
    await renderRecord();

    expect(screen.getByText('no PRISMA equivalent')).toBeInTheDocument();
  });

  test('an unmeasured figure renders as "not recorded", never as zero', async () => {
    await renderRecord({
      ...RECORD,
      deduplication: {
        ...RECORD.deduplication,
        cross_source_duplicates: {
          count: null,
          recorded: false,
          prisma: 'Duplicate records removed before screening',
          meaning: 'Records identified as the same paper as a record from another source.',
          not_recorded_reason: 'This run predates the version that stored this '
            + 'figure. Not recorded is not zero.',
        },
      },
      caveats: [...RECORD.caveats, 'It is absent, not zero.'],
    });

    expect(screen.getByText('not recorded')).toBeInTheDocument();
    // And the reason renders beside it, not in a tooltip.
    expect(screen.getByText(/Not recorded is not zero/)).toBeInTheDocument();
  });

  test('the caveats render with the numbers, not behind a disclosure', async () => {
    await renderRecord();

    expect(screen.getByText('What these numbers do not mean')).toBeInTheDocument();
    expect(screen.getByText(/does not record screening decisions/)).toBeInTheDocument();
    expect(screen.getByText(/covers one execution/)).toBeInTheDocument();
  });

  test('the software version that ran the search is shown', async () => {
    await renderRecord();
    expect(screen.getByText('resmon 1.6.1')).toBeInTheDocument();
  });

  test('the exact terms and window are shown', async () => {
    await renderRecord();

    expect(screen.getByText('cardiac, transformer')).toBeInTheDocument();
    expect(screen.getByText('2026-01-01 to 2026-06-30')).toBeInTheDocument();
  });

  test('the markdown export links to the backend, which names the file', async () => {
    await renderRecord();

    const link = screen.getByRole('link', { name: /download as markdown/i });
    expect(link).toHaveAttribute(
      'href', expect.stringContaining('/search-record?format=markdown'));
  });

  test('a failure says so instead of rendering an empty record', async () => {
    (global as any).fetch = jest.fn(async () => ({
      ok: false,
      status: 404,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({ detail: 'No execution with id 42' }),
      json: async () => ({ detail: 'No execution with id 42' }),
    }));
    await act(async () => { render(<SearchRecord executionId={42} />); });

    expect(screen.getByText(/No execution with id 42/)).toBeInTheDocument();
  });
});
