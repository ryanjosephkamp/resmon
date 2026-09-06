/**
 * The renderer half of 1.9b: the duplicate badge, the collapse toggle, and the
 * coverage panel.
 *
 * **P12 in the interface.** A link must never make a row disappear on its own.
 * Collapse is off on arrival, the total above the list does not move when it is
 * switched on, and the folded rows come back when it is switched off. Those are
 * the three ways a reader could be quietly shown less than the corpus holds.
 *
 * **P15's jsdom half.** The two lists render, and so does the sentence about what
 * the audit cannot see — which is asserted as hard as the lists are, because it
 * is the part a tidy-up would remove first.
 */

import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ExplorerPage from '../pages/ExplorerPage';
import CoveragePanel from '../components/Routines/CoveragePanel';
import { notifyRoutinesChanged } from '../lib/routinesBus';

const NO_EMBEDDINGS = {
  run: { running: false, model: null, processed: 0, total: 0, skipped_no_text: 0,
         cancelled: false, reason: null },
  coverage: { embedded: 0, total: 0, model: null },
  extension: { extension: null, reason: 'not installed' },
  index: { model: null, dims: null, rows: 0 },
  capability: { available: false, extension: null, reason: 'not installed',
                model: null, indexed: 0 },
};

const FACETS = { sources: [], categories: [], authors: [], max_values: 30 };

function doc(id: number, title: string, source = 'arxiv') {
  return {
    id, title, authors: 'A. Author', abstract: 'An abstract.',
    publication_date: '2026-01-15', doi: null, url: null,
    source_repository: source, categories: null,
  };
}

/** Two records of the same work, plus one unrelated paper. */
const RESULTS = {
  results: [doc(1, 'Deep Sets', 'arxiv'), doc(2, 'Deep Sets', 'crossref'),
            doc(3, 'Soil microbes', 'pubmed')],
  next_cursor: null, has_more: false, total: 3,
  total_is_capped: false, used_full_text_index: false, sort: 'newest',
};

const LINKS = {
  links: {
    '1': [{ id: 2, title: 'Deep Sets', source_repository: 'crossref',
            kind: 'near_duplicate', score: 1.0, method: 'shared_doi',
            label: 'also appears in crossref — same DOI' }],
    '2': [{ id: 1, title: 'Deep Sets', source_repository: 'arxiv',
            kind: 'near_duplicate', score: 1.0, method: 'shared_doi',
            label: 'also appears in arxiv — same DOI' }],
  },
};

const COLLAPSE = { keep: [1, 3], folded: { '1': [1, 2] } };

function mockExplorer() {
  (global as any).fetch = jest.fn(async (url: string) => ({
    ok: true, status: 200,
    headers: { get: () => 'application/json' },
    json: async () => {
      const u = String(url);
      if (u.includes('/api/embeddings/status')) return NO_EMBEDDINGS;
      if (u.includes('/api/links/for-documents')) return LINKS;
      if (u.includes('/api/links/collapse-preview')) return COLLAPSE;
      if (u.includes('/facets')) return FACETS;
      if (u.includes('/lifecycle')) return { events: {}, checked: {} };
      return RESULTS;
    },
    text: async () => '',
  }));
}

async function renderExplorer() {
  mockExplorer();
  await act(async () => {
    render(<MemoryRouter initialEntries={['/explorer']}><ExplorerPage /></MemoryRouter>);
  });
}


// ---------------------------------------------------------------------------
// The badge
// ---------------------------------------------------------------------------

test('a paper resmon has seen twice says so, and names the evidence', async () => {
  await renderExplorer();
  const badges = screen.getAllByTestId('duplicate-links');
  expect(badges.length).toBe(2);
  expect(badges[0].textContent).toContain('same DOI');
  expect(badges[0].textContent).toContain('also appears in crossref');
});

test('a paper with no link carries no badge', async () => {
  await renderExplorer();
  // Three results, two of them linked.
  expect(screen.getAllByTestId('duplicate-links').length).toBe(2);
});


// ---------------------------------------------------------------------------
// P12 — collapse hides nothing on its own
// ---------------------------------------------------------------------------

test('collapse is off on arrival and every row is rendered', async () => {
  await renderExplorer();
  const toggle = screen.getByTestId('collapse-toggle')
    .querySelector('input') as HTMLInputElement;
  expect(toggle.checked).toBe(false);
  expect(screen.getAllByRole('listitem').length).toBe(3);
  expect(screen.queryByTestId('collapse-note')).toBeNull();
});

test('switching collapse on folds a row and says so without changing the total',
  async () => {
    await renderExplorer();
    const before = screen.getByText(/3 papers in your corpus/);
    expect(before).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByTestId('collapse-toggle').querySelector('input')!);
    });

    expect(screen.getAllByRole('listitem').length).toBe(2);
    const note = screen.getByTestId('collapse-note').textContent || '';
    expect(note).toContain('1 row folded');
    expect(note).toContain('Nothing was removed');
    // The count above the list is the backend's and does not move.
    expect(screen.getByText(/3 papers in your corpus/)).toBeTruthy();
  });

test('the folded row says what it is standing in for', async () => {
  await renderExplorer();
  await act(async () => {
    fireEvent.click(screen.getByTestId('collapse-toggle').querySelector('input')!);
  });
  expect(screen.getByText(/Standing in for 2 records/)).toBeTruthy();
});

test('switching collapse off brings the rows straight back', async () => {
  await renderExplorer();
  const input = screen.getByTestId('collapse-toggle').querySelector('input')!;
  await act(async () => { fireEvent.click(input); });
  expect(screen.getAllByRole('listitem').length).toBe(2);
  await act(async () => { fireEvent.click(input); });
  expect(screen.getAllByRole('listitem').length).toBe(3);
  expect(screen.queryByTestId('collapse-note')).toBeNull();
});

test('the collapse toggle is absent when nothing is linked', async () => {
  (global as any).fetch = jest.fn(async (url: string) => ({
    ok: true, status: 200,
    headers: { get: () => 'application/json' },
    json: async () => {
      const u = String(url);
      if (u.includes('/api/embeddings/status')) return NO_EMBEDDINGS;
      if (u.includes('/api/links/for-documents')) return { links: {} };
      if (u.includes('/facets')) return FACETS;
      if (u.includes('/lifecycle')) return { events: {}, checked: {} };
      return RESULTS;
    },
    text: async () => '',
  }));
  await act(async () => {
    render(<MemoryRouter initialEntries={['/explorer']}><ExplorerPage /></MemoryRouter>);
  });
  expect(screen.queryByTestId('collapse-toggle')).toBeNull();
});


// ---------------------------------------------------------------------------
// P15 (jsdom) — the coverage panel
// ---------------------------------------------------------------------------

const COVERAGE = {
  routine_id: 4, routine_name: 'astro',
  intent: 'irregular astronomical time series', intent_source: 'stated',
  model: 'nomic-embed-text',
  cannot_see: 'resmon can only compare against papers it already holds. A paper '
    + 'missing from this list may simply never have been collected by any routine.',
  results: 40, results_embedded: 40,
  off_target: [{ id: 9, distance: 0.812, title: 'Soil microbes',
                 source_repository: 'pubmed', publication_date: '2026-02-02', url: null }],
  missed_in_corpus: [{ id: 11, distance: 0.104, title: 'Cadence and irregular sampling',
                       source_repository: 'arxiv', publication_date: '2026-03-03',
                       url: null }],
  distribution: { count: 40, min: 0.02, median: 0.31, p75_cutoff: 0.55, max: 0.9 },
  reason: null,
  off_target_total: 1,
  missed_in_corpus_total: 1,
  missed_in_corpus_total_is_lower_bound: false,
};

/** One row of each list, standing for a page of 25 out of a much larger whole. */
const CAPPED = {
  ...COVERAGE,
  off_target_total: 312,
  missed_in_corpus_total: 63,
};

function mockCoverage(payload: unknown = COVERAGE) {
  (global as any).fetch = jest.fn(async () => ({
    ok: true, status: 200,
    headers: { get: () => 'application/json' },
    json: async () => payload,
    text: async () => '',
  }));
}

async function openCoverage(payload: unknown = COVERAGE) {
  mockCoverage(payload);
  await act(async () => { render(<CoveragePanel routineId={4} />); });
  await act(async () => { fireEvent.click(screen.getByTestId('coverage-toggle')); });
}

test('the audit renders both lists', async () => {
  await openCoverage();
  expect(screen.getByText('Furthest from the intent')).toBeTruthy();
  expect(screen.getByText('Soil microbes')).toBeTruthy();
  expect(screen.getByText('Already collected, never returned by this routine')).toBeTruthy();
  expect(screen.getByText('Cadence and irregular sampling')).toBeTruthy();
});

test('the panel fetches nothing until it is opened', async () => {
  mockCoverage();
  await act(async () => { render(<CoveragePanel routineId={4} />); });
  expect((global as any).fetch).not.toHaveBeenCalled();
  await act(async () => { fireEvent.click(screen.getByTestId('coverage-toggle')); });
  expect((global as any).fetch).toHaveBeenCalled();
});

test('what the audit cannot see is rendered, not implied', async () => {
  await openCoverage();
  expect(screen.getByTestId('coverage-cannot-see').textContent)
    .toContain('only compare against papers it already holds');
});

test('the off-target list is worded as a prompt rather than a verdict', async () => {
  await openCoverage();
  expect(screen.getByText(/prompt to look, not a verdict/)).toBeTruthy();
});

test('an audit built from keywords says the comparison is against the query itself',
  async () => {
    await openCoverage({ ...COVERAGE, intent: 'time series', intent_source: 'keywords' });
    const intent = screen.getByTestId('coverage-intent').textContent || '';
    expect(intent).toContain('keywords');
    expect(intent).toContain('measures the query against results the query produced');
  });

test('a routine that cannot be audited shows the reason rather than empty lists',
  async () => {
    await openCoverage({
      ...COVERAGE, off_target: [], missed_in_corpus: [], distribution: null,
      reason: 'This routine has not returned any papers yet.',
    });
    expect(screen.getByTestId('coverage-reason').textContent)
      .toContain('has not returned any papers yet');
    expect(screen.queryByText('Furthest from the intent')).toBeNull();
  });

// ---------------------------------------------------------------------------
// R2 — a page says it is a page
// ---------------------------------------------------------------------------

test('a capped list says how many there are in total', async () => {
  /**
   * Both lists stop at 25. A reader given 25 rows and no count reads that as
   * "25 results are off target" — precise, and a number resmon never measured.
   */
  await openCoverage(CAPPED);
  expect(screen.getByTestId('coverage-off-target-showing').textContent)
    .toBe('Showing 1 of 312.');
  expect(screen.getByTestId('coverage-missed-showing').textContent)
    .toBe('Showing 1 of 63.');
});

test('an uncapped list says nothing, because there is nothing to say', async () => {
  await openCoverage();
  expect(screen.queryByTestId('coverage-off-target-showing')).toBeNull();
  expect(screen.queryByTestId('coverage-missed-showing')).toBeNull();
});

test('a missed total the backend could only bound is worded as a floor', async () => {
  /**
   * The missed side comes from a bounded index query, so its total can be a
   * floor rather than a count, and the backend says which. "63" and "at least
   * 63" are different facts; rendering the first for the second would be the
   * overclaim this feature exists to avoid, one layer down.
   */
  await openCoverage({ ...CAPPED, missed_in_corpus_total_is_lower_bound: true });
  expect(screen.getByTestId('coverage-missed-showing').textContent)
    .toBe('Showing 1 of at least 63.');
  // The off-target total is exact and must not borrow the qualifier.
  expect(screen.getByTestId('coverage-off-target-showing').textContent)
    .toBe('Showing 1 of 312.');
});

test('a payload from an older backend renders without a caption rather than a wrong one',
  async () => {
    /**
     * `off_target_total` did not exist before 1.9.2. A panel that fell back to
     * the page length would print "Showing 1 of 1" and call a truncated list
     * complete; absent is the honest rendering of absent.
     */
    const { off_target_total, missed_in_corpus_total,
            missed_in_corpus_total_is_lower_bound, ...older } = CAPPED;
    await openCoverage(older);
    expect(screen.queryByTestId('coverage-off-target-showing')).toBeNull();
    expect(screen.queryByTestId('coverage-missed-showing')).toBeNull();
  });

test('editing a routine discards a cached audit rather than showing the old one',
  async () => {
    /**
     * The audit is cached after the first open, because it costs two vector
     * queries and an embedding call. But the intent it compares against is
     * edited on this same page — so a user who writes one, reopens the panel and
     * reads the previous answer would conclude the field did nothing. The edit
     * modal broadcasts on save; this listens.
     */
    await openCoverage();
    expect((global as any).fetch).toHaveBeenCalledTimes(1);

    // Re-opening without a change must not refetch: that is what the cache is for.
    await act(async () => { fireEvent.click(screen.getByTestId('coverage-toggle')); });
    await act(async () => { fireEvent.click(screen.getByTestId('coverage-toggle')); });
    expect((global as any).fetch).toHaveBeenCalledTimes(1);

    await act(async () => { notifyRoutinesChanged(); });
    expect((global as any).fetch).toHaveBeenCalledTimes(2);
  });
