import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { DraftsProvider } from '../../../shell/drafts';
import { Search } from '../../Search';
import { WatchEditor } from '../../watches/WatchEditor';
import { PEOPLE_KEY } from '../../watches/people/model';
import type { CatalogEntry } from '../../runs/model';

const source = (slug: string, required = false, query = slug === 'arxiv' ? 'field' : 'none'): CatalogEntry => ({
  slug, name: slug, rate_limit: '1.0 req/s', keyword_combination: 'Implicit AND', date_granularity: 'day',
  api_key_requirement: required ? 'required' : 'none', credential_name: required ? `${slug}_key` : null,
  result_order: 'unstated', entity_search: { author_query: query },
  constraints: { records_per_request: null, default_start_days: null, notices: [] },
} as unknown as CatalogEntry);

const realFetch = globalThis.fetch;
beforeEach(() => { globalThis.fetch = jest.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch; });
afterEach(() => { globalThis.fetch = realFetch; });

function mount(path: string, extra?: CatalogEntry) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['catalog'], [source('arxiv'), source('openalex'), source('core', true), ...(extra ? [extra] : [])]);
  client.setQueryData(['runnable-sources'], ['arxiv', 'openalex', 'core', ...(extra ? [extra.slug] : [])]);
  client.setQueryData(['credentials'], { credentials: {} });
  client.setQueryData(PEOPLE_KEY, { profiles: [] });
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><DraftsProvider><Routes>
    <Route path="/search/ask" element={<Search />} /><Route path="/watches/new" element={<WatchEditor />} />
  </Routes></DraftsProvider></MemoryRouter></QueryClientProvider>);
}

test.each(['/search/ask?kind=sweep', '/watches/new'])('bulk selection at %s selects askable sources beyond the name filter and updates its plan', path => {
  const { container } = mount(path);
  if (path.startsWith('/search')) fireEvent.click(screen.getByRole('button', { name: 'Deep Sweep' }));
  fireEvent.change(screen.getByRole('searchbox', { name: 'Filter the sources by name' }), { target: { value: 'arxiv' } });
  fireEvent.click(screen.getByRole('button', { name: 'Select All' }));
  expect(container.querySelector('[data-catalog="chosen"]')?.textContent).toContain('arxiv');
  expect(container.querySelector('[data-catalog="chosen"]')?.textContent).toContain('openalex');
  expect(container.querySelector('[data-catalog="chosen"]')?.textContent).not.toContain('core');
  if (path.startsWith('/search')) expect(screen.getByRole('button', { name: 'Ask 2 Sources' })).toBeInTheDocument();
  else expect(container.querySelector('[data-will="asks"]')?.textContent).toContain('arxiv and openalex');
  fireEvent.click(screen.getByRole('button', { name: 'Deselect All' }));
  expect(container.querySelector('[data-catalog="chosen"]')).toBeNull();
  if (path.startsWith('/search')) expect(screen.getByRole('button', { name: 'Ask' })).toBeDisabled();
  else expect(container.querySelector('[data-will="asks"]')?.textContent).toContain('the sources you choose');
});

test('a Deep Dive has neither bulk control', () => {
  mount('/search/ask');
  expect(screen.queryByRole('button', { name: 'Select All' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Deselect All' })).toBeNull();
});


test('a person watch selects only sources that can be asked about an author', () => {
  const { container } = mount('/watches/new');
  fireEvent.click(screen.getByRole('radio', { name: 'A person: their new papers' }));
  fireEvent.click(screen.getByRole('button', { name: 'Select All' }));
  expect(container.querySelector('[data-catalog="chosen"]')?.textContent).toContain('arxiv');
  expect(container.querySelector('[data-catalog="chosen"]')?.textContent).not.toContain('openalex');
  expect(container.querySelector('[data-catalog="chosen"]')?.textContent).not.toContain('core');
});


test('a person watch leaves an unverified author capability out of Select All', () => {
  const { container } = mount('/watches/new', source('unverified', false, 'unknown'));
  fireEvent.click(screen.getByRole('radio', { name: 'A person: their new papers' }));
  fireEvent.click(screen.getByRole('button', { name: 'Select All' }));
  expect(container.querySelector('[data-catalog="chosen"]')?.textContent).toContain('arxiv');
  expect(container.querySelector('[data-catalog="chosen"]')?.textContent).not.toContain('unverified');
  expect(container.querySelector('[data-source="unverified"] input')).not.toBeChecked();
});
