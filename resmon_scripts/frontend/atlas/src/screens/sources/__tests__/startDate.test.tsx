/**
 * bioRxiv and medRxiv need a start date: each lists a date range oldest first,
 * so asked from its first preprints a search stops long before recent ones.
 * Ask the sources fills one in and will not let it be cleared while either is
 * chosen; a watch's editor will not save a watch on words that asks either
 * with no start, and offers the days the engine would give them.
 *
 * Both screens render here from a catalog seeded into the query cache. Every
 * other request the screens make is left unanswered.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Search } from '../../Search';
import type { CatalogEntry } from '../../runs/model';
import { WatchEditor } from '../../watches/WatchEditor';
import { PEOPLE_KEY } from '../../watches/people/model';
import { dayWords, daysBefore } from '../../watches/window';

const source = (slug: string, name: string, days: number | null): CatalogEntry => ({
  slug, name, rate_limit: '2.0 req/s', keyword_combination: 'Explicit OR', date_granularity: 'day',
  api_key_requirement: 'none', credential_name: null, result_order: 'unstated',
  entity_search: { author_query: 'none' },
  constraints: { notices: [], records_per_request: null, default_start_days: days },
} as unknown as CatalogEntry);

const realFetch = globalThis.fetch;
beforeEach(() => {
  // Nothing beyond the seeded cache is answered, so nothing here reaches a socket.
  globalThis.fetch = jest.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

function shown(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['catalog'], [source('arxiv', 'arXiv', null), source('biorxiv', 'bioRxiv', 3)]);
  client.setQueryData(['runnable-sources'], ['arxiv', 'biorxiv']);
  client.setQueryData(['credentials'], { credentials: {} });
  client.setQueryData(PEOPLE_KEY, { profiles: [] });
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/search/ask" element={<Search />} />
          <Route path="/watches/new" element={<WatchEditor />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const pick = (slug: string) => {
    const box = view.container.querySelector(`.source[data-source="${slug}"] input`);
    if (!box) throw new Error(`no ${slug} in the catalog`);
    fireEvent.click(box);
  };
  return { ...view, pick };
}

describe('Ask the sources', () => {
  test('choosing bioRxiv fills in a start, says why, and keeps it from being cleared', () => {
    const { container, pick } = shown('/search/ask');
    // A Deep Sweep, so a source chosen can be unchosen.
    fireEvent.click(screen.getByRole('button', { name: 'Deep Sweep' }));
    const anyTime = screen.getByRole('button', { name: 'Any time' });
    const from = screen.getByLabelText('From') as HTMLInputElement;
    fireEvent.click(anyTime);
    expect(from.value).toBe('');
    pick('arxiv');
    expect(from.value).toBe('');

    pick('biorxiv');
    const filled = daysBefore(3);
    expect(from.value).toBe(filled);
    expect(anyTime).toBeDisabled();
    expect(anyTime).toHaveAttribute('aria-pressed', 'false');
    const line = () => container.querySelector('[data-ask="start-needed"]')?.textContent;
    expect(line()).toBe(`bioRxiv needs a start date, so this search starts 3 days back, on ${dayWords(filled)}: it lists a `
      + 'date range oldest first, and asked from its first preprints a search stops long before recent ones.');

    // Changed: kept, and the line no longer says the form chose it.
    fireEvent.change(from, { target: { value: '2026-10-01' } });
    expect(from.value).toBe('2026-10-01');
    expect(line()).toMatch(/^bioRxiv needs a start date, so Any time is not offered while it is chosen: /);
    // Cleared: filled in again.
    fireEvent.change(from, { target: { value: '' } });
    expect(from.value).toBe(filled);

    // Unchosen, the blank it stood in for comes back, and Any time with it.
    pick('biorxiv');
    expect(from.value).toBe('');
    expect(line()).toBeUndefined();
    expect(anyTime).toBeEnabled();
    fireEvent.click(anyTime);
    expect(anyTime).toHaveAttribute('aria-pressed', 'true');
  });

  test('a source that needs no start leaves Any time as it is', () => {
    const { container, pick } = shown('/search/ask');
    pick('arxiv');
    fireEvent.click(screen.getByRole('button', { name: 'Any time' }));
    expect((screen.getByLabelText('From') as HTMLInputElement).value).toBe('');
    expect(container.querySelector('[data-ask="start-needed"]')).toBeNull();
  });
});

describe('a watch\'s editor', () => {
  const facts = (container: HTMLElement) => [...container.querySelectorAll('.ask-go .ask-facts p')].map((p) => p.textContent);
  const NEEDS = 'bioRxiv needs a start date, and this window gives none: it lists a date range oldest first, and asked '
    + 'from its first preprints a search stops long before recent ones.';

  test('a watch on bioRxiv is not saved with no start, and the last 3 days are offered', () => {
    const { container, pick } = shown('/watches/new');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Agents' } });
    fireEvent.change(screen.getByLabelText('Terms to watch for'), { target: { value: 'agent' } });
    pick('biorxiv');
    const save = screen.getByRole('button', { name: 'Save watch' });
    // Since the previous run is a window with a start.
    expect(save).toBeEnabled();

    fireEvent.click(screen.getByRole('radio', { name: 'No date limit' }));
    expect(save).toBeDisabled();
    expect(facts(container)).toEqual([NEEDS]);
    const offer = container.querySelector('[data-editor="start-offer"]') as HTMLButtonElement;
    expect(offer.textContent).toBe('Ask for the last 3 days');
    fireEvent.click(offer);
    expect(screen.getByRole('radio', { name: 'In the last 3 days' })).toBeChecked();
    expect(container.querySelector('[data-editor="start-needed"]')).toBeNull();
    expect(save).toBeEnabled();

    // Fixed dates with an end and no start are refused the same way, and a start lets it save.
    fireEvent.click(screen.getByRole('radio', { name: 'Between two dates' }));
    expect(facts(container)).toEqual([NEEDS]);
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-31' } });
    expect(facts(container)).toEqual([NEEDS]);
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-01' } });
    expect(facts(container)).toEqual([]);
    expect(save).toBeEnabled();
  });

  test('no date limit stays a choice for sources that need no start, and for a watch on a person', () => {
    const { container, pick } = shown('/watches/new');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Agents' } });
    fireEvent.change(screen.getByLabelText('Terms to watch for'), { target: { value: 'agent' } });
    pick('arxiv');
    fireEvent.click(screen.getByRole('radio', { name: 'No date limit' }));
    expect(facts(container)).toEqual([]);
    // A person's sources are asked about the person, never for a date range.
    pick('biorxiv');
    fireEvent.click(screen.getByRole('radio', { name: 'A person: their new papers' }));
    expect(facts(container)).toEqual(['Choose the person it watches for.']);
    expect(container.querySelector('[data-editor="start-needed"]')).toBeNull();
  });
});
