import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { engine } from '../../../api/client';
import { saveFile } from '../../runs/downloads';
import { SharedWording } from '../SharedWording';

jest.mock('../../../api/client', () => ({ ...jest.requireActual('../../../api/client'), engine: jest.fn() }));
jest.mock('../../runs/downloads', () => ({ saveFile: jest.fn() }));

const pair = { a: 1, b: 2, category: 'different_authors', reasons: [], reason_words: null,
  longest: 24, share: 0.25, authors_in_common: 0,
  left: { id: 1, title: '=Private, first\nTitle', publication_date: '2026-01-01', source_repository: 'crossref' },
  right: { id: 2, title: 'Second title', publication_date: '2026-01-02', source_repository: 'arxiv' } };
const overview = { state: 'ready', method_version: 1, job: { running: false }, scan: null, arrived_since: 0, withheld: 0,
  settings: { phrase_words: 8, min_words: 40, common_works: 3, shown_longest: 20, shown_share: 0.2 },
  definitions: { longest: 'Longest definition.', share: 'Share definition.', authors: 'Author definition.' }, limits: ['No claim about cause.'],
  groups: [{ category: 'different_authors', label: 'No Author in Common', note: 'Pairs to read.', count: 1, pairs: [pair] },
    { category: 'standard_statement', label: 'Standard Statements', note: 'Recurring sentences.', count: 1, pairs: [{ ...pair, category: 'standard_statement', a: 3, b: 4, reasons: ['standard_statement:6'], reason_words: 'This statement recurs across 6 unrelated works.' }] }] };

function mount(at = '/search/wording') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[at]}><SharedWording /></MemoryRouter></QueryClientProvider>);
}

beforeEach(() => {
  jest.clearAllMocks();
  (engine as jest.Mock).mockReturnValue({ GET: (route: string) => Promise.resolve({ data: route === '/api/shared-wording' ? overview : [], response: {} }) });
});

test('the page links its method, separates recurring statements, and exports every listed pair', async () => {
  mount();
  expect(await screen.findByRole('heading', { name: /Standard Statements/ })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'How Shared Wording Works' })).toHaveAttribute('href', 'https://ryanjosephkamp.github.io/resmon/guide/shared-wording/');
  fireEvent.click(screen.getByRole('button', { name: 'Export Page CSV' }));
  const csv = String((saveFile as jest.Mock).mock.calls[0]?.[0]);
  expect(csv).toContain('Second title');
  expect(csv).toContain("'=Private, first\nTitle");
  expect(csv).toContain('standard_statement');
  fireEvent.click(screen.getByRole('button', { name: 'Export Page Markdown' }));
  const markdown = String((saveFile as jest.Mock).mock.calls[1]?.[0]);
  expect(markdown).toContain('Standard Statements');
  expect(markdown).toContain('Longest definition.');
  expect(markdown).toContain('No claim about cause.');
});

test('charts state their listed-pair counts, filter the pairs, and restore every group', async () => {
  mount();
  const chart = await screen.findByRole('region', { name: 'Pairs by How Much They Share' });
  expect(chart).toHaveTextContent('25% to under 50%: 2 pairs');
  expect(chart).toHaveTextContent('Under 25%: 0 pairs');
  expect(chart).toHaveTextContent('Listed pairs only');
  fireEvent.click(screen.getByRole('button', { name: /Standard Statements: 1 pair/ }));
  expect(screen.getByRole('status', { name: 'Pair Filter' })).toHaveTextContent('Standard Statements');
  expect(document.querySelectorAll('.wording-row')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Export Page Markdown' }));
  expect(String((saveFile as jest.Mock).mock.calls[0]?.[0])).not.toContain('## No Author in Common');
  fireEvent.click(screen.getByRole('button', { name: 'Show All Pairs' }));
  expect(document.querySelectorAll('.wording-row')).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: /Under 25%: 0 pairs/ }));
  expect(document.querySelectorAll('.wording-row')).toHaveLength(0);
  expect(screen.getByText('No listed pairs match this filter.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Show All Pairs' }));
  expect(document.querySelectorAll('.wording-row')).toHaveLength(2);
});

test('a filter keeps its identity through an open pair and back, and intersects with the other chart', async () => {
  mount('/search/wording?band=25to50&kind=standard');
  const row = await screen.findByRole('button', { name: /Paper 1/ });
  expect(document.querySelectorAll('.wording-row')).toHaveLength(1);
  fireEvent.click(row);
  fireEvent.click(await screen.findByRole('button', { name: 'Back to Filtered Pairs' }));
  expect(await screen.findByRole('status', { name: 'Pair Filter' })).toHaveTextContent('25% to under 50% · Standard Statements');
  expect(document.querySelectorAll('.wording-row')).toHaveLength(1);
});
