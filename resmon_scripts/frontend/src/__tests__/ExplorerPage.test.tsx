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

function mockApi(results = RESULTS) {
  (global as any).fetch = jest.fn(async (url: string) => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => (String(url).includes('/facets') ? FACETS : results),
    text: async () => '',
  }));
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

    const body = JSON.parse(((global as any).fetch as jest.Mock).mock.calls[0][1].body);
    expect(body.sources).toEqual(['arxiv']);
    expect(body.categories).toEqual(['cs.LG']);
  });

  test('a date range from the URL reaches the query', async () => {
    mockApi();
    await renderAt('/explorer?from=2026-01-01&to=2026-06-30');

    const body = JSON.parse(((global as any).fetch as jest.Mock).mock.calls[0][1].body);
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
