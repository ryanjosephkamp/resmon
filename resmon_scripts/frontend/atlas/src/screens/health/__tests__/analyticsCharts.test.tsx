/**
 * Analytics' marks: each one's tip, in the engine's numbers unrounded, and
 * where a click on it goes, which is what it counts. A source's bar and range
 * open the collection narrowed to the source; a keyword's bar opens it
 * searched for the words, unless the term has search operators, when it opens
 * nothing and its tip offers nothing; a month's column opens the papers
 * published that month; a watch's tick opens its run.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { engine } from '../../../api/client';
import { Analytics } from '../Analytics';
import {
  collectionFor, keywordTip, lagTip, monthRange, sourceTip, volumeTip, watchRunTip,
  type KeywordContribution, type Overview,
} from '../analyticsModel';

jest.mock('../../../api/client', () => ({ ...jest.requireActual('../../../api/client'), engine: jest.fn() }));

if (!('PointerEvent' in window)) {
  class PointerEventShim extends MouseEvent {}
  Object.defineProperty(window, 'PointerEvent', { value: PointerEventShim, configurable: true });
}

const reply = (data: unknown) => Promise.resolve({ data, error: undefined, response: {} as Response });

const OVERVIEW: Overview = {
  summary: {
    documents: 12408, unique_papers: 11900, distinct_authors: 30000, sources: 2, completed_executions: 3,
    doi_coverage: 0.6125, first_seen: '2026-01-02T00:00:00Z', last_seen: '2026-11-01T00:00:00Z', sample_size: 12408, sufficient: true,
  },
  source_contribution: {
    sufficient: true, insufficient_reason: null, sample_size: 12408,
    sources: [
      { source: 'arxiv', total: 9000, unique_papers: 7051, duplicated: 1949, unique_share: 0.7834 },
      { source: 'crossref', total: 3408, unique_papers: 1459, duplicated: 1949, unique_share: 0.4281 },
    ],
  },
  discovery_lag: {
    sufficient: true, insufficient_reason: null, sample_size: 12000, minimum_sample: 5,
    sources: [
      { source: 'arxiv', sample_size: 8900, sufficient: true, median_days: 0.4, fastest_days: -2.3, slowest_days: 41.5 },
      { source: 'crossref', sample_size: 3, sufficient: false, median_days: null, fastest_days: null, slowest_days: null },
    ],
  },
  routine_health: {
    sufficient: true, insufficient_reason: null, sample_size: 1, minimum_runs: 3, stale_after: 3,
    routines: [{
      routine_id: 4, name: 'Perovskite films', missed_fires: 0, last_missed_fire_at: null, schedule_cron: '0 9 * * *',
      is_active: true, runs: 4, runs_since_new: 0, last_new_result_at: null, total_new: 5, unrecorded_runs: 1, status: 'healthy',
      sample_size: 4, sufficient: true,
      series: [
        { execution_id: 31, start_time: '2026-11-01T09:00:00Z', new_results: 4, total_results: 1250 },
        { execution_id: 32, start_time: '2026-11-02T09:00:00Z', new_results: 0, total_results: 5 },
        { execution_id: 33, start_time: '2026-11-02T21:00:00Z', new_results: null, total_results: null },
        { execution_id: 35, start_time: '2026-11-03T09:00:00Z', new_results: 1, total_results: 5 },
      ],
    }],
  },
  publication_volume: {
    group_by: 'source', groups: ['arxiv', 'crossref'], sufficient: true, insufficient_reason: null, sample_size: 30,
    series: [
      { month: '2026-02', total: 10, groups: { arxiv: 7, crossref: 3 } },
      { month: '2026-10', total: 20, groups: { crossref: 12, arxiv: 8 } },
    ],
  },
};

const KEYWORDS: KeywordContribution = {
  scope: { type: 'corpus' }, sufficient: true, insufficient_reason: null, sample_size: 40, minimum_sample_for_share: 10,
  documents_considered: 40, documents_matched: 30, documents_unexplained: 10, fields_checked: ['title', 'abstract'],
  keywords: [
    { keyword: 'perovskite', matched: 25, unique: 20, shared: 5, contains_operators: false, unique_share: 0.8 },
    { keyword: '"tandem cell" OR silicon', matched: 8, unique: 3, shared: 5, contains_operators: true, unique_share: null },
  ],
};

const names = (slug: string) => ({ arxiv: 'arXiv', crossref: 'Crossref' } as Record<string, string>)[slug] ?? slug;

describe('what each mark says', () => {
  test('a source\'s bar: its papers, its two parts, and its share to every place the engine gave', () => {
    const tip = sourceTip(OVERVIEW.source_contribution.sources[0]!, 'arXiv', true);
    expect(tip).toEqual({
      name: 'arXiv', value: '9,000 papers',
      lines: [
        { value: '7,051', label: 'only from this source', key: 'accent' },
        { value: '1,949', label: 'also from another source', key: 'context' },
      ],
      notes: ['78.34% of its papers came from no other source.'],
      opens: 'Opens Search › Your collection narrowed to arXiv',
    });
  });

  test('a keyword with search operators opens nothing, and its tip says why it is matched apart', () => {
    const plain = keywordTip(KEYWORDS.keywords[0]!, 10);
    expect(plain.opens).toBe('Opens Search › Your collection searched for these words');
    expect(plain.notes).toEqual(['80% matched this term and no other.']);
    const operators = keywordTip(KEYWORDS.keywords[1]!, 10);
    expect(operators.opens).toBeNull();
    expect(operators.notes?.[0]).toBe('A share needs 10 matches.');
  });

  test('a source\'s range in days as the engine rounded them, and a source with too few dated papers', () => {
    const [arxiv, crossref] = OVERVIEW.discovery_lag.sources;
    expect(lagTip(arxiv!, 'arXiv', 5)).toMatchObject({
      value: '0.4 days, the median',
      lines: [{ value: '2.3 days before its stated date', label: 'the fastest' }, { value: '41.5 days', label: 'the slowest' }],
    });
    expect(lagTip(crossref!, 'Crossref', 5)).toMatchObject({ value: '3 dated papers', notes: ['A median needs 5 dated papers.'] });
  });

  test('a watch\'s tick names its run, and opens it; a count the run did not record is said so, never as none', () => {
    const [run, , unrecorded] = OVERVIEW.routine_health.routines[0]!.series;
    expect(watchRunTip(run!, 'Perovskite films')).toMatchObject({
      value: '4 new papers', lines: [{ value: '1,250', label: 'found in all' }], opens: 'Opens run 31',
    });
    expect(watchRunTip(unrecorded!, 'Perovskite films')).toMatchObject({
      value: 'New papers not recorded', lines: undefined, opens: 'Opens run 33',
    });
  });

  test('a month\'s column lists every group in it, largest first; by category its total is not a count of papers', () => {
    const month = OVERVIEW.publication_volume.series[1]!;
    expect(volumeTip(month, 'source', names)).toEqual({
      name: 'October 2026', value: '20 papers',
      lines: [{ value: '12', label: 'Crossref' }, { value: '8', label: 'arXiv' }],
      notes: undefined,
      opens: 'Opens Search › Your collection narrowed to papers published in October 2026',
    });
    const byCategory = volumeTip({ month: '2026-10', total: 9, groups: { other: 1, 'cs.LG': 5, '(uncategorised)': 3 } }, 'category', names);
    expect(byCategory.value).toBe('9 in all');
    expect(byCategory.notes).toEqual(['A paper in several categories is counted in each.']);
    expect(byCategory.lines?.map((l) => l.label)).toEqual(['cs.LG', 'No category given', 'Everything else']);
  });

  test('a month is its first day to its last, a leap year\'s February included', () => {
    expect(monthRange('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(monthRange('2028-02')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(monthRange('2026-13')).toBeNull();
    expect(collectionFor({ month: '2026-10' })).toBe('/search?from=2026-10-01&to=2026-10-31');
    expect(collectionFor({ words: 'perovskite' })).toBe('/search?q=perovskite');
  });
});

function Where() {
  const location = useLocation();
  return <p data-testid="where">{`${location.pathname}${location.search}`}</p>;
}

function page() {
  const GET = jest.fn((route: string) => reply(
    route === '/api/analytics/overview' ? OVERVIEW
      : route === '/api/repositories/catalog' ? [{ slug: 'arxiv', name: 'arXiv' }, { slug: 'crossref', name: 'Crossref' }]
        : route === '/api/analytics/keyword-contribution' ? KEYWORDS
          : route === '/api/analytics/publication-volume' ? OVERVIEW.publication_volume : { counts: { alarms: 0 } },
  ));
  (engine as jest.Mock).mockReturnValue({ GET });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/health/analytics']}>
        <Routes>
          <Route path="/health/analytics" element={<Analytics />} />
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('a click goes to what the mark counts', () => {
  test('a source\'s row, its bar included, opens the collection narrowed to it; the tip is the engine\'s numbers', async () => {
    page();
    const card = (await screen.findByRole('heading', { name: 'Which sources earn their place' })).closest('section')!;
    const link = within(card).getByRole('link', { name: /^arXiv: 9,000 papers/ });
    expect(link).toHaveAttribute('href', '/search?source=arxiv');
    const row = link.closest('li')!;
    fireEvent.pointerEnter(row, { clientX: 300, clientY: 100 });
    expect(screen.getByRole('tooltip')).toHaveTextContent('78.34% of its papers came from no other source.');
    fireEvent.click(row.querySelector('.chart-bar')!);
    expect(screen.getByTestId('where')).toHaveTextContent('/search?source=arxiv');
  });

  test('a source\'s range opens it too, with too few dated papers or not', async () => {
    page();
    const card = (await screen.findByRole('heading', { name: 'How quickly each source surfaces a paper' })).closest('section')!;
    expect(within(card).getByRole('link', { name: /^Crossref: 3 dated papers/ })).toHaveAttribute('href', '/search?source=crossref');
    fireEvent.click(card.querySelector('.bar-row[data-source="arxiv"] .range')!);
    expect(screen.getByTestId('where')).toHaveTextContent('/search?source=arxiv');
  });

  test('a watch\'s ticks are one stop that opens each run, the newest first to the keyboard', async () => {
    page();
    const strip = await screen.findByRole('group', { name: /Perovskite films: new papers in each of its last 4 completed runs/ });
    const ticks = within(strip).getAllByRole('link');
    expect(ticks.map((t) => t.getAttribute('href'))).toEqual(['/runs/31', '/runs/32', '/runs/33', '/runs/35']);
    expect(ticks.map((t) => t.tabIndex)).toEqual([-1, -1, -1, 0]);
    // A run that did not record its count is its own hollow mark, never a bar of none.
    expect(ticks[2]).toHaveAttribute('data-unrecorded', 'true');
    expect(ticks[2]).not.toHaveAttribute('data-zero');
    expect(ticks[2]!.querySelector<HTMLElement>('.run-tick-bar')?.style.height).toBe('');
    act(() => ticks[3]!.focus());
    fireEvent.keyDown(ticks[3]!, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(ticks[2]);
    expect(screen.getByRole('tooltip')).toHaveTextContent('New papers not recorded');
    fireEvent.keyDown(ticks[2]!, { key: 'ArrowLeft' });
    expect(screen.getByRole('tooltip')).toHaveTextContent('0 new papers');
    fireEvent.click(ticks[1]!);
    expect(screen.getByTestId('where')).toHaveTextContent('/runs/32');
  });

  test('a month\'s column opens the papers published that month', async () => {
    page();
    const columns = await screen.findByRole('group', { name: 'Papers by publication month' });
    const months = within(columns).getAllByRole('link');
    expect(months.map((m) => m.getAttribute('href'))).toEqual([
      '/search?from=2026-02-01&to=2026-02-28', '/search?from=2026-10-01&to=2026-10-31',
    ]);
    fireEvent.pointerEnter(months[1]!, { clientX: 500, clientY: 300 });
    expect(screen.getByRole('tooltip')).toHaveTextContent('October 2026');
    expect(screen.getByRole('tooltip')).toHaveTextContent('12 Crossref');
  });

  test('a keyword opens the collection searched for it; one with operators opens nothing and its tip offers nothing', async () => {
    page();
    fireEvent.click(await screen.findByRole('button', { name: 'Measure keyword yield' }));
    const plain = await screen.findByRole('link', { name: /^perovskite: 25 papers matched/ });
    expect(plain).toHaveAttribute('href', '/search?q=perovskite');
    const operators = document.querySelector('li[data-keyword="\\"tandem cell\\" OR silicon"]')!;
    expect(operators.querySelector('a')).toBeNull();
    fireEvent.pointerEnter(operators, { clientX: 300, clientY: 300 });
    expect(screen.getByRole('tooltip').querySelector('.chart-tip-opens')).toBeNull();
    fireEvent.click(operators.querySelector('.chart-bar')!);
    expect(screen.queryByTestId('where')).toBeNull();
  });
});
