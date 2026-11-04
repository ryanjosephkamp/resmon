/**
 * A source that has announced its own end (OpenAIRE) carries a notice from the
 * catalog, shown on its row where sources are chosen and said in full under
 * Ask once it is chosen. Other sources show none.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { DraftsProvider } from '../../../shell/drafts';
import { Search } from '../../Search';
import type { CatalogEntry } from '../../runs/model';

const NOTICE = 'OpenAIRE has announced the end of the API resmon asks it through.';
const source = (slug: string, name: string, notice = ''): CatalogEntry => ({
  slug, name, rate_limit: '1.0 req/s', keyword_combination: 'Implicit AND', date_granularity: 'day',
  api_key_requirement: 'none', credential_name: null, result_order: 'unstated', service_notice: notice,
  entity_search: { author_query: 'none' },
  constraints: { records_per_request: null, default_start_days: null, notices: [] },
} as unknown as CatalogEntry);

const realFetch = globalThis.fetch;
beforeEach(() => { globalThis.fetch = jest.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch; });
afterEach(() => { globalThis.fetch = realFetch; });

test('the notice is on the source\'s row, and said under Ask once it is chosen', () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['catalog'], [source('arxiv', 'arXiv'), source('openaire', 'OpenAIRE', NOTICE)]);
  client.setQueryData(['runnable-sources'], ['arxiv', 'openaire']);
  client.setQueryData(['credentials'], { credentials: {} });
  const { container } = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/search/ask']}>
        <DraftsProvider><Routes><Route path="/search/ask" element={<Search />} /></Routes></DraftsProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const tags = container.querySelectorAll('[data-notice="service"]');
  expect(tags).toHaveLength(1);
  expect(tags[0]?.closest('[data-source]')?.getAttribute('data-source')).toBe('openaire');
  expect(tags[0]?.getAttribute('title')).toBe(NOTICE);
  expect(screen.queryByText(NOTICE)).toBeNull();

  fireEvent.click(container.querySelector('.source[data-source="openaire"] input') as Element);
  expect(container.querySelector('[data-ask="service-notice"]')?.textContent).toBe(NOTICE);
  fireEvent.click(container.querySelector('.source[data-source="arxiv"] input') as Element);
  expect(container.querySelectorAll('[data-ask="service-notice"]')).toHaveLength(0);
});
