/**
 * Explorer page.
 *
 * The behaviors worth guarding: an incoming filtered link is honoured, filters
 * live in the URL so they survive Back and can be shared, and an empty result
 * offers a way out instead of a blank page.
 */

import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ExplorerPage from '../pages/ExplorerPage';

const FACETS = {
  sources: [{ value: 'arxiv', count: 120 }, { value: 'pubmed', count: 40 }],
  categories: [{ value: 'cs.LG', count: 90 }],
  authors: [{ value: 'Ada Lovelace', count: 12 }],
  max_values: 30,
};

const RESULTS = {
  results: [{
    id: 1, title: 'Diffusion models', authors: 'Ada Lovelace',
    abstract: 'An abstract.', publication_date: '2026-01-15',
    doi: '10.1/x', url: 'https://e.org/1',
    source_repository: 'arxiv', categories: 'cs.LG, stat.ML',
  }],
  next_cursor: null, has_more: false, total: 1,
  total_is_capped: false, used_full_text_index: true,
};

/** No embedding lane, no vector extension: the shape most installs are in. */
const NO_EMBEDDINGS = {
  run: { running: false, model: null, processed: 0, total: 0, skipped_no_text: 0,
         cancelled: false, reason: null },
  coverage: { embedded: 0, total: 0, model: null },
  extension: { extension: null, reason: 'not installed' },
  index: { model: null, dims: null, rows: 0 },
  capability: { available: false, extension: null, reason: 'not installed',
                model: null, indexed: 0 },
};

function mockApi(results: unknown = RESULTS, embeddings: unknown = NO_EMBEDDINGS) {
  (global as any).fetch = jest.fn(async (url: string) => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => {
      const u = String(url);
      if (u.includes('/api/embeddings/status')) return embeddings;
      if (u.includes('/facets')) return FACETS;
      return results;
    },
    text: async () => '',
  }));
}

/**
 * The body of the corpus-search call, found rather than indexed.
 *
 * It used to be `mock.calls[0]`, which broke the moment the page gained a
 * second request on mount -- and broke with "undefined is not valid JSON"
 * rather than with anything that named the cause. A test that depends on the
 * order of unrelated requests is a test that fails for unrelated reasons.
 */
function searchBody(): any {
  const calls = ((global as any).fetch as jest.Mock).mock.calls;
  const call = calls.find(([url, init]: [string, any]) =>
    String(url).includes('/api/explorer/search') && init?.body);
  if (!call) throw new Error('the page never searched the corpus');
  return JSON.parse(call[1].body);
}

async function renderAt(path: string) {
  await act(async () => {
    render(
      <MemoryRouter initialEntries={[path]}>
        <ExplorerPage />
      </MemoryRouter>,
    );
  });
}

describe('Explorer page', () => {
  test('renders results and their metadata', async () => {
    mockApi();
    await renderAt('/explorer');

    expect(screen.getByText('Diffusion models')).toBeInTheDocument();
    expect(screen.getByText('10.1/x')).toBeInTheDocument();
    // 'Ada Lovelace' is legitimately both an author line and an author facet,
    // so assert on the one inside the result rather than on the text globally.
    const item = document.querySelector('.explorer-item') as HTMLElement;
    expect(item).toBeTruthy();
    expect(item.querySelector('.explorer-authors')?.textContent).toBe('Ada Lovelace');
    expect(item.querySelector('.explorer-source')?.textContent).toBe('arxiv');
    expect(screen.getByText(/1 paper in your corpus/i)).toBeInTheDocument();
  });

  test('an incoming filtered link is applied, not ignored', async () => {
    mockApi();
    await renderAt('/explorer?source=arxiv&category=cs.LG');

    // This is the Analytics handoff: the link is the whole point of the feature.
    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    const checked = boxes.filter((b) => b.checked);
    expect(checked.length).toBe(2);

    const body = searchBody();
    expect(body.sources).toEqual(['arxiv']);
    expect(body.categories).toEqual(['cs.LG']);
  });

  test('a date range from the URL reaches the query', async () => {
    mockApi();
    await renderAt('/explorer?from=2026-01-01&to=2026-06-30');

    const body = searchBody();
    expect(body.date_from).toBe('2026-01-01');
    expect(body.date_to).toBe('2026-06-30');
  });

  test('a capped total is shown as approximate, not exact', async () => {
    mockApi({ ...RESULTS, total: 10000, total_is_capped: true });
    await renderAt('/explorer');
    expect(screen.getByText(/10,000\+/)).toBeInTheDocument();
  });

  test('no matches offers a way out rather than a blank page', async () => {
    mockApi({ ...RESULTS, results: [], total: 0 });
    await renderAt('/explorer?source=arxiv');

    expect(screen.getByText(/Nothing matches every filter/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /clear all filters/i })).toBeInTheDocument();
  });

  test('an empty corpus explains itself instead of showing an empty filter', async () => {
    mockApi({ ...RESULTS, results: [], total: 0 });
    await renderAt('/explorer');

    expect(screen.getByText(/Nothing collected yet/i)).toBeInTheDocument();
    expect(screen.getByText(/Deep Dive or Deep Sweep/i)).toBeInTheDocument();
  });
});


// ---------------------------------------------------------------------------
// Ranking by meaning (1.9)
// ---------------------------------------------------------------------------

/** A build that can rank: extension loaded, vectors in the index. */
const CAN_RANK = {
  run: { running: false, model: 'nomic-embed-text', processed: 0, total: 0,
         skipped_no_text: 0, cancelled: false, reason: null },
  coverage: { embedded: 400, total: 400, model: 'nomic-embed-text' },
  extension: { extension: 'v0.1.9', reason: null },
  index: { model: 'nomic-embed-text', dims: 768, rows: 400 },
  capability: { available: true, extension: 'v0.1.9', reason: null,
                model: 'nomic-embed-text', indexed: 400 },
};

const RANKED_RESULTS = {
  ...RESULTS,
  results: [
    { ...RESULTS.results[0], id: 1, distance: 0.123 },
    { ...RESULTS.results[0], id: 2, title: 'Not embedded yet', distance: null },
  ],
  total: 2,
  sort: 'similarity',
  ranked_count: 1,
  unranked_count: 1,
  model: 'nomic-embed-text',
};

describe('Explorer page — ranking by meaning', () => {
  test('the sort control is absent when this build cannot rank', async () => {
    // P5's renderer half. Not disabled and explained: absent. A control that is
    // present and inert is a promise the app is not keeping.
    mockApi(RESULTS, NO_EMBEDDINGS);
    await renderAt('/explorer?q=diffusion');
    expect(screen.queryByTestId('explorer-sort')).toBeNull();
    expect(screen.queryByText('Papers like this one')).toBeNull();
  });

  test('the sort control appears when it can, and the similar panel with it', async () => {
    mockApi(RESULTS, CAN_RANK);
    await renderAt('/explorer?q=diffusion');
    expect(screen.getByTestId('explorer-sort')).toBeTruthy();
    expect(screen.getAllByText('Papers like this one').length).toBeGreaterThan(0);
  });

  test('the similarity sort reaches the request', async () => {
    mockApi(RANKED_RESULTS, CAN_RANK);
    await renderAt('/explorer?q=diffusion&sort=similarity');
    expect(searchBody().sort).toBe('similarity');
  });

  test('a ranked list says what it is closest to, and how much is unranked', async () => {
    mockApi(RANKED_RESULTS, CAN_RANK);
    await renderAt('/explorer?q=diffusion&sort=similarity');
    const note = screen.getByTestId('rank-note').textContent || '';
    expect(note).toContain('Closest to:');
    expect(note).toContain('diffusion');
    expect(note).toContain('nomic-embed-text');
    // The count is stated rather than left to be inferred from a short list.
    expect(note).toContain('1 not embedded yet');
  });

  test('an unranked paper reads as not ranked, not as a large distance', async () => {
    mockApi(RANKED_RESULTS, CAN_RANK);
    await renderAt('/explorer?q=diffusion&sort=similarity');
    expect(screen.getByText('0.123')).toBeTruthy();
    expect(screen.getByText('not ranked')).toBeTruthy();
  });

  test('a similarity request the backend declined is reported, not hidden', async () => {
    // The failure this rules out: a date order presented under a "closest to"
    // label. The list must be labelled by the sort it is actually in.
    mockApi(
      { ...RESULTS, sort: 'newest', similarity_unavailable: 'No embedding model is configured.' },
      CAN_RANK,
    );
    await renderAt('/explorer?q=diffusion&sort=similarity');
    expect(screen.getByTestId('rank-unavailable').textContent)
      .toContain('No embedding model is configured.');
    expect(screen.queryByTestId('rank-note')).toBeNull();
  });

  test('an empty ranked result explains that the text filter is what emptied it', async () => {
    // Measured on the real corpus: 11 of 20 natural-language queries match no
    // paper on the AND-over-words text filter, so this is the common case, not
    // the edge one. "No papers match" alone hides both the reason and the fact
    // that a corpus-wide ranking would have had an answer.
    mockApi({ ...RESULTS, results: [], total: 0, sort: 'similarity' }, CAN_RANK);
    await renderAt('/explorer?q=how+do+cells+decide+to+divide&sort=similarity');
    const note = screen.getByTestId('similarity-empty-note').textContent || '';
    expect(note).toContain('Ranking by meaning still searches inside your text filter');
  });

  test('asking to rank with no search phrase says what is missing', async () => {
    mockApi(RESULTS, CAN_RANK);
    await renderAt('/explorer?sort=similarity');
    expect(screen.getByTestId('rank-needs-query')).toBeTruthy();
  });
});
