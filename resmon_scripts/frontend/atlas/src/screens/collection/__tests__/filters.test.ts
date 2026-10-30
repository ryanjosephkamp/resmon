import {
  chips, countSentence, dateRangeProblem, engineFilters, exportedWords, exportWords, facetCaption, facetRows,
  filterCount, narrowingWords, othersSet, readFilters, toggled, withDate, withoutFilters,
} from '../filters';
import { collectionFor } from '../../health/analyticsModel';

const read = (search: string) => readFilters(new URLSearchParams(search));

describe('the collection’s filters, held in the address', () => {
  test('a chart’s link on Analytics is the same state as ticking the value here', () => {
    const fromChart = new URLSearchParams(collectionFor({ source: 'crossref' }).split('?')[1]);
    const ticked = toggled(new URLSearchParams(), 'source', 'crossref');
    expect(readFilters(fromChart)).toEqual(readFilters(ticked));
    expect(read(collectionFor({ category: 'physics.app-ph' }).split('?')[1] ?? '')).toMatchObject({ categories: ['physics.app-ph'] });
  });

  test('each group may repeat; blanks and repeats are not filters, and a date must be a calendar day', () => {
    expect(read('source=arxiv&source=crossref&source=arxiv&category=&author=Ada%20Fixture&from=2026-10-01&to=2026-13-45'))
      .toEqual({ sources: ['arxiv', 'crossref'], categories: [], authors: ['Ada Fixture'], from: '2026-10-01', to: '' });
    expect(read('from=October')).toMatchObject({ from: '' });
    expect(filterCount(read('source=arxiv&source=crossref&category=cs.LG&from=2026-10-01'))).toBe(4);
    expect(filterCount(read(''))).toBe(0);
  });

  test('ticking adds a value, ticking it again takes it off, and the other keys stay as they were', () => {
    const start = new URLSearchParams('source=arxiv&category=cs.LG&sort=whatever');
    const added = toggled(start, 'source', 'crossref');
    expect(added.getAll('source')).toEqual(['arxiv', 'crossref']);
    expect(added.get('category')).toBe('cs.LG');
    expect(added.get('sort')).toBe('whatever');
    expect(toggled(added, 'source', 'arxiv').getAll('source')).toEqual(['crossref']);
    expect(start.getAll('source')).toEqual(['arxiv']);
  });

  test('a date is set, replaced, or taken off; clearing every filter keeps what is not one', () => {
    const dated = withDate(new URLSearchParams('author=Ada'), 'from', '2026-10-01');
    expect(dated.get('from')).toBe('2026-10-01');
    expect(withDate(dated, 'from', '').has('from')).toBe(false);
    const cleared = withoutFilters(new URLSearchParams('source=arxiv&category=x&author=y&from=2026-01-01&to=2026-02-01&q=keep'));
    expect(cleared.toString()).toBe('q=keep');
  });

  test('the words narrow the counts and the export only where they narrow the list', () => {
    expect(narrowingWords('perovskite', 'newest')).toBe('perovskite');
    expect(narrowingWords('perovskite films that last', 'similarity')).toBe('');
    expect(engineFilters(read('source=arxiv&to=2026-10-31'), '')).toEqual({
      query: null, sources: ['arxiv'], categories: [], authors: [], date_from: null, date_to: '2026-10-31',
    });
    expect(engineFilters(read(''), 'crystals').query).toBe('crystals');
  });

  test('a group’s own ticks are not the “other” filters its numbers answer to', () => {
    const f = read('source=arxiv&source=crossref');
    expect(othersSet(f, 'source')).toBe(false);
    expect(othersSet(f, 'category')).toBe(true);
    expect(othersSet(read('from=2026-01-01'), 'author')).toBe(true);
  });
});

describe('what a count means, said where it is shown', () => {
  test('each group’s caption names what its numbers count, and against what', () => {
    expect(facetCaption('source', { words: false, others: false }, 2, 30))
      .toBe('Each number counts the papers from that source in your collection. Tick several to see papers from any of them.');
    expect(facetCaption('category', { words: true, others: true }, 3, 30))
      .toBe('Each number counts the papers in that category that match your words and your other filters. '
        + 'A paper can be in several, and ticking several shows papers in any of them.');
    expect(facetCaption('author', { words: true, others: false }, 1, 30)).toMatch(/^Each number counts the papers by that author that match your words\. /);
    expect(facetCaption('source', { words: false, others: true }, 1, 30)).toMatch(/that match your other filters\./);
  });

  test('a list the engine cut at its limit says so', () => {
    expect(facetCaption('author', { words: false, others: false }, 30, 30))
      .toMatch(/ Only the 30 authors with the most papers are listed\.$/);
    expect(facetCaption('author', { words: false, others: false }, 29, 30)).not.toMatch(/Only the/);
  });

  test('a ticked value the engine did not list is 0 when its list is whole, and uncounted when the list was cut', () => {
    const listed = [{ value: 'arxiv', count: 5 }, { value: 'crossref', count: 3 }];
    expect(facetRows(listed, ['crossref', 'pubmed'], 30)).toEqual([
      { value: 'arxiv', count: 5, chosen: false },
      { value: 'crossref', count: 3, chosen: true },
      { value: 'pubmed', count: 0, chosen: true },
    ]);
    expect(facetRows(listed, ['pubmed'], 2)[2]).toEqual({ value: 'pubmed', count: null, chosen: true });
  });

  test('the count sentence keeps its words, and a capped count its plus', () => {
    expect(countSentence({ total: 3, total_is_capped: false }, false, '')).toBe('3 papers in your collection');
    expect(countSentence({ total: 1, total_is_capped: false }, false, 'crystals')).toBe('1 paper match');
    expect(countSentence({ total: 2, total_is_capped: false }, true, '')).toBe('2 papers matching your filters');
    expect(countSentence({ total: 10000, total_is_capped: true }, true, 'perovskite'))
      .toBe('10,000+ papers matching your filters and these words');
  });
});

describe('each filter named, and how it comes off', () => {
  const names = (slug: string) => ({ arxiv: 'arXiv', crossref: 'CrossRef' }[slug] ?? slug);

  test('one value in a group widens to the whole group; one of several drops only itself', () => {
    expect(chips(read('source=crossref'), names)).toEqual([
      { key: 'source', value: 'crossref', text: 'From CrossRef', remove: 'Show papers from every source, not only CrossRef' },
    ]);
    expect(chips(read('source=arxiv&source=crossref'), names).map((c) => c.remove))
      .toEqual(['Stop showing papers from arXiv', 'Stop showing papers from CrossRef']);
  });

  test('dates are said as US dates, whatever the time zone', () => {
    const said = chips(read('category=cs.LG&author=Ada%20Fixture&from=2026-10-01&to=2026-10-31'), names).map((c) => c.text);
    expect(said).toEqual(['In cs.LG', 'By Ada Fixture', 'Published from October 1, 2026', 'Published through October 31, 2026']);
  });

  test('a range that ends before it starts says why nothing matches', () => {
    expect(dateRangeProblem(read('from=2026-10-31&to=2026-10-01')))
      .toBe('October 31, 2026 is after October 1, 2026, so no paper can be published between them.');
    expect(dateRangeProblem(read('from=2026-10-01&to=2026-10-01'))).toBeNull();
  });
});

describe('what an export will hold, said before it is saved', () => {
  test('every paper the count counts, by number', () => {
    expect(exportWords({ total: 3, total_is_capped: false, count_cap: 10000 }, 'newest'))
      .toEqual({ lead: 'Export these 3 papers as', note: null });
    expect(exportWords({ total: 1, total_is_capped: false, count_cap: 10000 }, 'newest')?.lead).toBe('Export this paper as');
    expect(exportWords({ total: 0, total_is_capped: false, count_cap: 10000 }, 'newest')).toBeNull();
  });

  test('past the engine’s cap, the file’s size and what it leaves out are said first', () => {
    expect(exportWords({ total: 10000, total_is_capped: true, count_cap: 10000 }, 'newest')).toEqual({
      lead: 'Export the newest 10,000 as',
      note: 'An export holds at most 10,000 papers, so this file will hold the newest 10,000 of the 10,000+ that match; '
        + 'narrow the filters to reach the rest.',
    });
  });

  test('ranked by meaning, the file keeps the papers and not the order', () => {
    expect(exportWords({ total: 4, total_is_capped: false, count_cap: 10000 }, 'similarity')?.note)
      .toBe('The file lists them newest first, not in order of meaning.');
  });

  test('once saved, the engine’s own count of what it wrote', () => {
    expect(exportedWords(3, 'resmon-collection.bib')).toBe('3 papers into resmon-collection.bib; the save dialog asks where it goes.');
    expect(exportedWords(null, 'resmon-collection.csv')).toBe('Exported into resmon-collection.csv; the save dialog asks where it goes.');
  });
});
