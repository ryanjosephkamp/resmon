import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { engine } from '../../../api/client';
import { CollectionProvider } from '../../../collections/current';
import { Collection } from '../Collection';

jest.mock('../../../api/client', () => ({ ...jest.requireActual('../../../api/client'), engine: jest.fn() }));
jest.mock('../../sky/PaperSky', () => ({ PaperSky: () => null, basisWords: () => 'by shared wording' }));
jest.mock('../ResultList', () => ({ ResultList: () => null }));

test('a Search count waits for the collection names, then wraps at name separators without changing its text', async () => {
  let finish!: (result: unknown) => void;
  const collections = new Promise((resolve) => { finish = resolve; });
  const response = (data: unknown) => Promise.resolve({ data, response: {} });
  (engine as jest.Mock).mockReturnValue({
    GET: (route: string) => route === '/api/collections' ? collections : route === '/api/repositories/catalog' ? response([])
      : route === '/api/executions/active' ? response({ running: [], waiting: [], recent: [], last_ended_at: null }) : new Promise(() => {}),
    POST: () => response({ results: [], total: 0, total_is_exact: true, sort: 'newest', has_more: false }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter><CollectionProvider><Collection /></CollectionProvider></MemoryRouter></QueryClientProvider>);
  await waitFor(() => expect(client.getQueryCache().findAll({ queryKey: ['explorer'] })[0]?.state.status).toBe('success'));
  await waitFor(() => expect(document.querySelector('.results')).toHaveAttribute('aria-busy', 'false'));
  expect(document.querySelector('.count-sentence')?.textContent).toBe('');
  expect(document.querySelector('.index-empty')).toBeNull();
  const name = 'Materials_science-and/optics';
  await act(async () => finish({ data: { current_id: 1, default_id: 1, collections: [
    { id: 1, name, papers: 0, watches: 0, is_default: true }, { id: 2, name: 'Field Notes', papers: 0, watches: 0, is_default: false },
  ] }, response: {} }));
  const heading = await screen.findByRole('heading', { name });
  expect([...heading.querySelectorAll('wbr')].map((node) => node.previousSibling?.textContent)).toEqual(['Materials_', 'science-', 'and/']);
  await waitFor(() => expect(document.querySelector('.count-sentence')).toHaveTextContent(`0 papers in ${name}`));
  expect(document.querySelector('.index-empty')).toHaveTextContent(`${name} holds no papers yet.`);
});
