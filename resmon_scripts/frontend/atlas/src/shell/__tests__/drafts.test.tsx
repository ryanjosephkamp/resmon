/**
 * A form not yet sent survives leaving its screen: Back and Forward find it as
 * it was left, on its own history entry, and a new visit starts fresh. Ask the
 * sources and the watch editor are rendered here from a catalog seeded into
 * the query cache; every other request they make is left unanswered.
 */
import { useEffect } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useNavigate, type NavigateFunction } from 'react-router-dom';
import { Search } from '../../screens/Search';
import type { CatalogEntry } from '../../screens/runs/model';
import { WatchEditor } from '../../screens/watches/WatchEditor';
import { PEOPLE_KEY } from '../../screens/watches/people/model';
import { AI_KEY } from '../../screens/settings/summaryLanes';
import { DraftStore, DraftsProvider } from '../drafts';

describe('the draft store', () => {
  it('keeps a draft per key, forgets one when asked, and lets the longest untouched go past its limit', () => {
    const store = new DraftStore(2);
    store.write('a', 1);
    store.write('b', 2);
    expect(store.read('a')).toBe(1);
    store.write('a', 3); // touched again: now the newest
    store.write('c', 4);
    expect(store.read('b')).toBeNull();
    expect(store.read('a')).toBe(3);
    expect(store.read('c')).toBe(4);
    store.drop('a');
    expect(store.read('a')).toBeNull();
    expect(store.size).toBe(1);
  });
});

const source = (slug: string, name: string): CatalogEntry => ({
  slug, name, rate_limit: '1.0 req/s', keyword_combination: 'Implicit AND', date_granularity: 'day',
  api_key_requirement: 'none', credential_name: null, result_order: 'unstated',
  entity_search: { author_query: 'none' },
  constraints: { records_per_request: null, default_start_days: null, notices: [] },
} as unknown as CatalogEntry);

const realFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = jest.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

/** The router's navigate, handed out so a test can go Back and Forward as the shell's keys do. */
const router: { navigate: NavigateFunction } = { navigate: () => undefined };
const go: NavigateFunction = ((to: unknown) => router.navigate(to as never)) as NavigateFunction;
function Navigator() {
  const navigate = useNavigate();
  useEffect(() => { router.navigate = navigate; }, [navigate]);
  return null;
}

/** The screen at `path`, reached by a link from a first page, so its entry is one the router made and keyed. */
function app(path: string, { linked = true } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['catalog'], [source('arxiv', 'arXiv'), source('crossref', 'Crossref')]);
  client.setQueryData(['runnable-sources'], ['arxiv', 'crossref']);
  client.setQueryData(['credentials'], { credentials: {} });
  client.setQueryData(PEOPLE_KEY, { profiles: [] });
  client.setQueryData(AI_KEY, { settings: {} });
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[linked ? '/' : path]}>
        <DraftsProvider>
          <Navigator />
          <Routes>
            <Route path="/search/ask" element={<Search />} />
            <Route path="/watches/new" element={<WatchEditor />} />
            <Route path="/settings/ai" element={<p>Settings › AI</p>} />
            <Route path="/" element={<p>Today</p>} />
          </Routes>
        </DraftsProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  if (linked) act(() => { go(path); });
  return view;
}

const terms = (container: HTMLElement) => [...container.querySelectorAll('.term')].map((t) => t.textContent);
const checked = (container: HTMLElement, slug: string) =>
  (container.querySelector(`.source[data-source="${slug}"] input`) as HTMLInputElement | null)?.checked;

describe('Ask the sources, left for Settings › AI and come back to', () => {
  it('finds the search as it was left on Back, and a new visit starts fresh', () => {
    const { container } = app('/search/ask');
    const field = screen.getByLabelText('Search terms');
    fireEvent.change(field, { target: { value: 'perovskite' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    fireEvent.change(field, { target: { value: 'tandem' } });
    fireEvent.click(container.querySelector('.source[data-source="crossref"] input') as Element);
    fireEvent.change(screen.getByLabelText('Most papers per source'), { target: { value: '40' } });

    // The summaries line's link out, then Back.
    fireEvent.click(screen.getByRole('link', { name: 'Settings › AI' }));
    expect(container.querySelector('.ask')).toBeNull();
    act(() => { go(-1); });
    expect(terms(container)).toEqual(['perovskite']);
    expect((screen.getByLabelText('Search terms') as HTMLInputElement).value).toBe('tandem');
    expect(checked(container, 'crossref')).toBe(true);
    expect((screen.getByLabelText('Most papers per source') as HTMLInputElement).value).toBe('40');

    // Forward and Back again: still there.
    act(() => { go(1); });
    act(() => { go(-1); });
    expect(terms(container)).toEqual(['perovskite']);

    // A new visit to the same address is a new entry, and starts empty.
    act(() => { go('/settings/ai'); });
    act(() => { go('/search/ask'); });
    expect(terms(container)).toEqual([]);
    expect(checked(container, 'crossref')).toBe(false);
  });
});

describe('a form on an entry the router did not make', () => {
  it('keeps nothing there, since every such entry shares one key', () => {
    const { container } = app('/search/ask', { linked: false });
    const field = screen.getByLabelText('Search terms');
    fireEvent.change(field, { target: { value: 'perovskite' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    fireEvent.click(screen.getByRole('link', { name: 'Settings › AI' }));
    act(() => { go(-1); });
    expect(terms(container)).toEqual([]);
  });
});

describe('the watch editor, left for Settings › AI and come back to', () => {
  it('finds the watch being written as it was left on Back', () => {
    const { container } = app('/watches/new');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Tandem cells' } });
    const field = screen.getByLabelText('Terms to watch for');
    fireEvent.change(field, { target: { value: 'perovskite' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    fireEvent.click(container.querySelector('.source[data-source="arxiv"] input') as Element);

    fireEvent.click(screen.getAllByRole('link', { name: 'Settings › AI' })[0] as Element);
    expect(container.querySelector('.ask')).toBeNull();
    act(() => { go(-1); });
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Tandem cells');
    expect(terms(container)).toEqual(['perovskite']);
    expect(checked(container, 'arxiv')).toBe(true);
  });
});
