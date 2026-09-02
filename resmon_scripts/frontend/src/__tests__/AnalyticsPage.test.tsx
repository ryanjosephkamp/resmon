/**
 * Analytics page — the states that matter.
 *
 * The failure this suite exists to prevent is an interface that presents a
 * statistic the backend explicitly marked as untrustworthy, or that shows a
 * new user four broken charts instead of an explanation.
 */

import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AnalyticsPage from '../pages/AnalyticsPage';

const EMPTY = {
  summary: {
    documents: 0, unique_papers: 0, distinct_authors: 0, sources: 0,
    completed_executions: 0, doi_coverage: null, sample_size: 0, sufficient: false,
  },
  source_contribution: {
    sources: [], sample_size: 0, sufficient: false,
    insufficient_reason: 'Overlap needs at least two sources to compare.',
  },
  discovery_lag: {
    sources: [], sample_size: 0, sufficient: false, minimum_sample: 5,
    insufficient_reason: 'Needs at least 5 dated papers from a source.',
  },
  routine_health: {
    routines: [], minimum_runs: 3, stale_after: 3, sample_size: 0,
    sufficient: false, insufficient_reason: 'No routines created yet.',
  },
  publication_volume: {
    group_by: 'source', groups: [], series: [], sample_size: 0, sufficient: false,
    insufficient_reason: 'No papers with a usable publication date yet.',
  },
};

const POPULATED = {
  summary: {
    documents: 412, unique_papers: 390, distinct_authors: 1180, sources: 4,
    completed_executions: 22, doi_coverage: 0.931, sample_size: 412, sufficient: true,
  },
  source_contribution: {
    sources: [
      { source: 'arxiv', total: 240, unique_papers: 190, duplicated: 50, unique_share: 0.79 },
      { source: 'crossref', total: 60, unique_papers: 2, duplicated: 58, unique_share: 0.03 },
    ],
    sample_size: 300, sufficient: true, insufficient_reason: null,
  },
  discovery_lag: {
    sources: [
      { source: 'arxiv', sample_size: 200, sufficient: true, median_days: 1.2, fastest_days: 0.1, slowest_days: 30.0 },
      { source: 'hal', sample_size: 3, sufficient: false, median_days: null, fastest_days: null, slowest_days: null },
    ],
    sample_size: 203, sufficient: true, minimum_sample: 5, insufficient_reason: null,
  },
  routine_health: {
    routines: [
      {
        routine_id: 1, name: 'Diffusion models', is_active: true, runs: 14,
        runs_since_new: 6, last_new_result_at: '2026-06-30T08:00:00', total_new: 41,
        status: 'stale',
        series: [
          { start_time: '2026-06-29T08:00:00', new_results: 3 },
          { start_time: '2026-06-30T08:00:00', new_results: 1 },
          { start_time: '2026-07-01T08:00:00', new_results: 0 },
        ],
      },
      {
        routine_id: 2, name: 'Protein folding', is_active: true, runs: 62,
        runs_since_new: 0, last_new_result_at: '2026-08-18T08:00:00', total_new: 300,
        status: 'healthy', series: [],
      },
    ],
    minimum_runs: 3, stale_after: 3, sample_size: 2, sufficient: true, insufficient_reason: null,
  },
  publication_volume: {
    group_by: 'source', groups: ['arxiv'],
    series: [
      { month: '2026-06', total: 40, groups: { arxiv: 40 } },
      { month: '2026-07', total: 55, groups: { arxiv: 55 } },
    ],
    sample_size: 95, sufficient: true, insufficient_reason: null,
  },
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

async function renderPage() {
  await act(async () => {
    render(
      <MemoryRouter>
        <AnalyticsPage />
      </MemoryRouter>,
    );
  });
}

describe('Analytics page', () => {
  test('an empty corpus explains itself instead of drawing empty charts', async () => {
    mockFetch(EMPTY);
    await renderPage();

    expect(screen.getByText(/Nothing to analyze yet/i)).toBeInTheDocument();
    // The analysis sections must not be rendered at all — an axis with no data
    // reads as breakage, not as emptiness. Queried as level-2 headings
    // specifically, because the collapsible help above still describes every
    // section by name, and should: the page explains itself before it has data.
    expect(
      screen.queryByRole('heading', { level: 2, name: /Which sources earn their place/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { level: 2, name: /^Routine health$/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { level: 2, name: /Publication volume/i }),
    ).not.toBeInTheDocument();
    // And it points somewhere useful.
    expect(screen.getByText(/Deep Dive/i)).toBeInTheDocument();
  });

  test('a populated corpus renders the headline counts', async () => {
    mockFetch(POPULATED);
    await renderPage();

    expect(screen.getByText('412')).toBeInTheDocument();
    expect(screen.getByText('1,180')).toBeInTheDocument();
    expect(screen.getByText('93%')).toBeInTheDocument();
  });

  test('a source that only duplicates others is visible as such', async () => {
    mockFetch(POPULATED);
    await renderPage();

    // 'arxiv' legitimately appears twice: once as a contribution bar, once as a
    // discovery-lag row. Assert on the counts, which are unambiguous.
    expect(screen.getAllByText('arxiv').length).toBeGreaterThan(0);
    expect(screen.getByText('190 / 240')).toBeInTheDocument();
    // crossref: 2 unique out of 60 — the number that tells you to switch it off.
    expect(screen.getByText('2 / 60')).toBeInTheDocument();
  });

  test('a per-source median below the threshold is withheld, not printed', async () => {
    mockFetch(POPULATED);
    await renderPage();

    expect(screen.getByText('1.2 d')).toBeInTheDocument();
    // hal has 3 samples; it must say what it needs rather than show a median.
    expect(screen.getByText(/needs 5/i)).toBeInTheDocument();
  });

  test('a quiet routine is labeled and says how long it has been quiet', async () => {
    mockFetch(POPULATED);
    await renderPage();

    expect(screen.getByText('Quiet')).toBeInTheDocument();
    expect(screen.getByText(/Nothing new in the last 6 runs/i)).toBeInTheDocument();
    expect(screen.getByText('Finding new work')).toBeInTheDocument();
  });

  test('the volume chart is stacked, with one segment per group', async () => {
    mockFetch(POPULATED);
    await renderPage();

    // POPULATED has two months, one group each.
    const segments = document.querySelectorAll('.analytics-volume-seg');
    expect(segments.length).toBe(2);
    // Identity is carried by a legend, never by color alone.
    expect(screen.getAllByText('arxiv').length).toBeGreaterThan(0);
  });

  test('the same figures are available as a table, not color alone', async () => {
    mockFetch(POPULATED);
    await renderPage();

    const toggle = screen.getByRole('button', { name: /show as a table/i });
    await act(async () => { toggle.click(); });

    expect(screen.getByRole('button', { name: /hide table/i })).toBeInTheDocument();
    expect(screen.getByText('2026-06')).toBeInTheDocument();
    expect(screen.getByText('2026-07')).toBeInTheDocument();
  });

  test('a failed load offers a retry rather than a blank page', async () => {
    (global as any).fetch = jest.fn(async () => ({
      ok: false,
      status: 500,
      headers: { get: () => 'application/json' },
      json: async () => ({ detail: 'boom' }),
      text: async () => '{"detail":"boom"}',
    }));
    await renderPage();

    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  // --- Which keywords earn their place ------------------------------------
  //
  // This section reads every paper in the corpus to evaluate every keyword
  // against it, which is why it is button-gated rather than loaded with the
  // rest of the page. The other thing it must get right is the framing: a paper
  // matching none of the user's keywords is normal on a relevance-ranked
  // source, and someone about to delete a term needs to know that first.

  test('keyword contribution is not measured until asked for', async () => {
    const mock = jest.fn(async (_i?: RequestInfo | URL, _n?: RequestInit) => ({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => POPULATED,
      text: async () => JSON.stringify(POPULATED),
    }));
    (global as any).fetch = mock;
    await renderPage();

    const asked = mock.mock.calls.filter(
      ([url]: any) => String(url).includes('keyword-contribution'),
    );
    expect(asked).toHaveLength(0);
    expect(screen.getByRole('button', { name: /measure keyword contribution/i }))
      .toBeInTheDocument();
  });

  test('measuring shows unique against shared, and explains the remainder', async () => {
    const KEYWORDS = {
      keywords: [
        { keyword: 'cardiac', matched: 340, unique: 300, shared: 40,
          unique_share: 0.88, contains_operators: false },
        { keyword: 'transformer', matched: 1208, unique: 8, shared: 1200,
          unique_share: 0.007, contains_operators: false },
      ],
      documents_considered: 1600,
      documents_matched: 1548,
      documents_unexplained: 52,
      minimum_sample_for_share: 10,
      sufficient: true,
      insufficient_reason: null,
    };
    (global as any).fetch = jest.fn(async (input?: RequestInfo | URL) => {
      const payload = String(input).includes('keyword-contribution')
        ? KEYWORDS : POPULATED;
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => payload,
        text: async () => JSON.stringify(payload),
      };
    });
    await renderPage();

    await act(async () => {
      screen.getByRole('button', { name: /measure keyword contribution/i }).click();
    });

    expect(screen.getByText('cardiac')).toBeInTheDocument();
    expect(screen.getByText('300 / 340')).toBeInTheDocument();
    // The actionable finding: 'transformer' brings in almost nothing of its own.
    expect(screen.getByText('8 / 1,208')).toBeInTheDocument();
    // And the papers no keyword accounts for are explained, not just counted.
    expect(screen.getByText(/rank by relevance rather than filtering on literal terms/))
      .toBeInTheDocument();
  });
});
