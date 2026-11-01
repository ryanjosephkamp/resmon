import type { CatalogEntry } from '../../runs/model';
import {
  WINDOWS, coarseMovingSentences, dayCount, daysBefore, formStart, listed, noLimitWords, relevanceSentence,
  runWindowSentence, startNeeded, watchWindowSentence, windowHint, windowOf, type DateWindowComputed,
} from '../window';

type Order = CatalogEntry['result_order'];

function entry(slug: string, name: string, order: Order, more: Partial<{ granularity: string; rounding: string }> = {}): CatalogEntry {
  return {
    slug, name, result_order: order, date_granularity: more.granularity ?? 'day',
    constraints: { window_rounding: more.rounding ?? 'none' },
  } as unknown as CatalogEntry;
}

const CATALOG = [
  entry('arxiv', 'arXiv', 'newest_first'),
  entry('crossref', 'Crossref', 'relevance'),
  entry('datacite', 'DataCite', 'relevance', { granularity: 'year', rounding: 'outward' }),
  entry('dblp', 'DBLP', 'unstated', { granularity: 'year', rounding: 'inward' }),
  entry('eric', 'ERIC', 'unstated', { granularity: 'year', rounding: 'inward' }),
  entry('nasa_ads', 'NASA ADS', 'newest_first', { granularity: 'month', rounding: 'outward' }),
  entry('pubmed', 'PubMed', 'newest_first'),
];

const NEXT = {
  mode: 'since_previous_run', basis: 'previous_run', date_from: '2026-10-26', date_to: null, days: null,
  previous_execution_id: 12, previous_start_time: '2026-10-29T08:00:00Z', overlap_days: 3, default_days: null,
  computed_at: '2026-10-30T14:00:00Z',
  sentence: 'The next run asks for papers published from October 26, 2026, with no end date: run 12, …',
} as DateWindowComputed;

describe('the four choices, in the order the editor offers them', () => {
  test('since the previous run first, no date limit last', () => {
    expect(WINDOWS.map((w) => w.label)).toEqual([
      'Papers published since the previous run', 'In the last N days', 'Between two dates', 'No date limit',
    ]);
  });

  test('a stored watch reads as the choice it is', () => {
    expect(windowOf({ date_window: { since: 'previous_run' }, date_from: '', date_to: '' }).window).toBe('previous_run');
    expect(windowOf({ date_window: { last_days: 45 } })).toMatchObject({ window: 'last_days', lastDays: 45 });
    expect(windowOf({ date_from: '2026-05-03' })).toMatchObject({ window: 'between', dateFrom: '2026-05-03', dateTo: '' });
    expect(windowOf({ date_from: '', date_to: '' }).window).toBe('none');
    expect(windowOf({}).window).toBe('none');
  });
});

describe('what each choice says it means', () => {
  test('since the previous run: the overlap and the first run, with the engine’s numbers', () => {
    expect(windowHint('previous_run', 30, CATALOG)).toBe(
      'Each run asks for papers published since the watch’s previous run, from 3 days before it started, because a '
      + 'source often lists a paper after the date it carries. A run with no earlier run behind it asks for the last 7 days. '
      + 'A paper already in your collection is not counted as new again.');
    expect(windowHint('last_days', 14, CATALOG)).toBe('Each run asks for papers published in the 14 days before it starts.');
  });

  test('no date limit says plainly what each source then answers with, naming them from the catalog', () => {
    expect(noLimitWords(CATALOG)).toBe(
      'Each run asks each source with no dates, and each answers in its own order: newest first from arXiv, NASA ADS, '
      + 'and PubMed; the most relevant of all years from Crossref and DataCite, mostly the same papers every run; and from '
      + 'the other 2, an order resmon has not established.');
    expect(windowHint('none', 30, CATALOG)).toBe(noLimitWords(CATALOG));
  });

  test('a relevance-ranked source with no date limit is a warning, by name', () => {
    expect(relevanceSentence([CATALOG[0] as CatalogEntry])).toBeNull();
    expect(relevanceSentence(CATALOG.slice(0, 2))).toBe(
      'Crossref ranks by relevance, so with no date limit every run gets the most relevant papers of all years from it, '
      + 'mostly the same ones each time, and finds little that is new there.');
  });

  test('a window that moves, at a source that dates papers by year or month', () => {
    expect(coarseMovingSentences(CATALOG)).toEqual([
      'DBLP and ERIC date papers only by year and are asked only for whole years inside a window, so a window that starts '
        + 'after January 1 asks them only for papers dated in a later year.',
      'DataCite and NASA ADS date papers only by year or month, so each run asks them from the start of the year or month '
        + 'its window starts in.',
    ]);
    expect(coarseMovingSentences([CATALOG[0] as CatalogEntry])).toEqual([]);
  });

  test('a list of three takes the serial comma', () => {
    expect(listed(['A'])).toBe('A');
    expect(listed(['A', 'B'])).toBe('A and B');
    expect(listed(['A', 'B', 'C'])).toBe('A, B, and C');
  });
});

describe('a watch’s page and a run’s page state the dates', () => {
  test('a window that moves is the engine’s sentence, with its dates', () => {
    expect(watchWindowSentence({ date_window: { since: 'previous_run' } }, NEXT))
      .toEqual({ window: 'previous_run', text: NEXT.sentence });
    // Before the engine has said, the choice alone, and no invented dates.
    expect(watchWindowSentence({ date_window: { last_days: 30 } }, null)?.text)
      .toBe('Each run asks for papers published in the 30 days before it starts.');
  });

  test('fixed dates and no dates are said as stored; a watch on retractions has no dates to state', () => {
    expect(watchWindowSentence({ date_from: '2026-05-03', date_to: '2026-05-04' }, null)?.text)
      .toBe('Every run asks for papers published from May 3, 2026 to May 4, 2026, the same dates each time.');
    expect(watchWindowSentence({}, null)?.text).toBe('Every run asks each source with no date limit, in the source’s own order.');
    expect(watchWindowSentence({ entity: { profile_id: 1, mode: 'retractions' } }, null)).toBeNull();
  });

  test('a run states the dates it asked, never the mode without them', () => {
    const fired = JSON.stringify({ date_from: '2026-10-26', date_to: null, date_window: { since: 'previous_run' },
      date_window_computed: { sentence: 'Papers published since the previous run: from October 26, 2026, with no end date.' } });
    expect(runWindowSentence(fired)).toBe('Papers published since the previous run: from October 26, 2026, with no end date.');
    expect(runWindowSentence(JSON.stringify({ date_from: '2026-10-01', date_to: '' }))).toBe('Papers published from October 1, 2026 on.');
    expect(runWindowSentence(JSON.stringify({ date_from: '', date_to: '' }))).toBe('No date limit: each source was asked with no dates.');
    expect(runWindowSentence('not json')).toBeNull();
  });
});

describe('sources that need a start date', () => {
  const needing = (slug: string, name: string): CatalogEntry => ({
    slug, name, result_order: 'unstated', date_granularity: 'day',
    constraints: { window_rounding: 'none', default_start_days: 3 },
  } as unknown as CatalogEntry);
  const SOURCES = [...CATALOG, needing('biorxiv', 'bioRxiv'), needing('medrxiv', 'medRxiv')];

  test('are the ones the catalog gives a start, with its days', () => {
    expect(startNeeded(CATALOG)).toBeNull();
    const needs = startNeeded(SOURCES);
    expect(needs?.entries.map((e) => e.slug)).toEqual(['biorxiv', 'medrxiv']);
    expect(needs?.days).toBe(3);
    expect(daysBefore(3, new Date(2026, 2, 2, 9, 0))).toBe('2026-02-27');
    expect(dayCount(1)).toBe('1 day');
    // A form's start counts back from an end date already past, so the window never ends before it starts.
    const now = new Date(2026, 9, 31, 12);
    expect(formStart(3, '', now)).toEqual({ day: '2026-10-28', before: 'today' });
    expect(formStart(3, '2026-10-01', now)).toEqual({ day: '2026-09-28', before: 'end' });
    expect(formStart(3, '2026-12-01', now)).toEqual({ day: '2026-10-28', before: 'today' });
  });

  test('a watch with no start says what each run asks them for, and only them', () => {
    const undated = { repositories: ['arxiv', 'biorxiv'], date_from: '', date_to: '' };
    expect(watchWindowSentence(undated, null, SOURCES)?.text).toBe(
      'Every run asks each source with no date limit, in the source’s own order, except bioRxiv, which needs a start '
      + 'date: each run asks it for the 3 days before it starts.');
    expect(watchWindowSentence({ repositories: ['biorxiv', 'medrxiv'], date_to: '2026-10-01' }, null, SOURCES)?.text).toBe(
      'Every run asks for papers published up to October 1, 2026, the same dates each time, except bioRxiv and medRxiv, '
      + 'which need a start date: each run asks them for the 3 days before its end date or the run, whichever is earlier.');
    // A start set, a window that moves, a person followed, or no such source: as before.
    expect(watchWindowSentence({ ...undated, date_from: '2026-10-01' }, null, SOURCES)?.text)
      .toBe('Every run asks for papers published from October 1, 2026 on, the same dates each time.');
    expect(watchWindowSentence({ ...undated, date_window: { last_days: 3 } }, null, SOURCES)?.text)
      .toBe('Each run asks for papers published in the 3 days before it starts.');
    expect(watchWindowSentence({ ...undated, entity: { mode: 'new_papers', profile_id: 1 } }, null, SOURCES)?.text)
      .toBe('Every run asks each source with no date limit, in the source’s own order.');
    expect(watchWindowSentence({ repositories: ['arxiv'] }, null, SOURCES)?.text)
      .toBe('Every run asks each source with no date limit, in the source’s own order.');
  });

  test('a run says the start the engine gave them, and that every other source had no dates', () => {
    const sentence = 'bioRxiv was asked from October 28, 2026, 3 days before the run started, because the run set no '
      + 'start date: bioRxiv lists a date range oldest first, so asked from its first preprints a search stops long '
      + 'before recent ones.';
    const starts = { biorxiv: { date_from: '2026-10-28', days: 3, before: 'run', sentence } };
    expect(runWindowSentence(JSON.stringify({ date_from: null, default_starts: starts })))
      .toBe(`No start date was set. ${sentence} Every other source was asked with no dates.`);
    expect(runWindowSentence(JSON.stringify({ date_to: '2026-10-31', default_starts: starts })))
      .toBe(`Papers published up to October 31, 2026. ${sentence}`);
    expect(runWindowSentence(JSON.stringify({ date_from: null }))).toBe('No date limit: each source was asked with no dates.');
  });
});
