import type { CatalogEntry } from '../../runs/model';
import { webhookTarget } from '../../watches/Destinations';
import { webhookUrl } from '../../watches/model';
import {
  askStartSentence, coarseFor, coarseSentence, formNotices, noneAskableAboutAuthors, paceOf, rateLong, rateShort, ratePerSecond,
} from '../catalog';

const entry = (slug: string, patch: Partial<CatalogEntry> & { author?: string } = {}): CatalogEntry => ({
  slug, name: slug, rate_limit: '1 req/s', date_granularity: 'day',
  entity_search: { author_query: patch.author ?? 'supported' },
  ...patch,
} as unknown as CatalogEntry);

describe('the catalog\'s stated limits, read', () => {
  test.each([
    ['0.33 req/s (1 per 3 s)', 0.33, '1 every 3 s', 'one request every 3 seconds'],
    ['10 req/s', 10, '10 a second', '10 requests a second'],
    ['0.0167 req/s', 0.0167, '1 every 1 min', 'one request every minute'],
  ])('%s', (stated, perSecond, short, long) => {
    expect(ratePerSecond(stated)).toBe(perSecond);
    expect(rateShort(perSecond, stated)).toBe(short);
    expect(rateLong(perSecond)).toBe(long);
  });

  test('an unstated limit is shown as stated, never guessed', () => {
    expect(ratePerSecond('Undocumented')).toBeNull();
    expect(rateShort(null, 'Undocumented')).toBe('Undocumented');
  });
});

test('the slowest of several sources sets the pace; one source sets none', () => {
  const slow = entry('arxiv', { rate_limit: '0.33 req/s' });
  const fast = entry('crossref', { rate_limit: '10 req/s' });
  expect(paceOf([fast, slow])?.entry.slug).toBe('arxiv');
  expect(paceOf([slow])).toBeNull();
});

test('a source that dates papers coarsely is named only for a window too short for it', () => {
  const yearly = entry('dblp', { date_granularity: 'year' });
  const monthly = entry('nasa', { date_granularity: 'month' });
  const daily = entry('arxiv');
  expect(coarseFor([yearly, monthly, daily], '2026-10-01', '2026-10-15').map((e) => e.slug)).toEqual(['dblp', 'nasa']);
  expect(coarseFor([yearly, monthly], '2026-08-01', '2026-10-15').map((e) => e.slug)).toEqual(['dblp']);
  expect(coarseFor([yearly], '', '')).toEqual([]);
  expect(coarseSentence([yearly])).toBe('dblp dates papers only to the year; a window this short may come back as one it could not answer.');
});

test('a source\'s notice is shown before asking only in the state of the form it is true in', () => {
  const constraints = (notices: { applies_when: string; effect: string }[], perRequest: number | null = null) => ({
    constraints: { notices: notices.map((n) => ({ kind: 'applied_default', established: '', ...n })), records_per_request: perRequest },
  });
  const biorxiv = entry('biorxiv', constraints([
    { applies_when: 'always', effect: 'bioRxiv cannot be asked for keywords.' },
    { applies_when: 'without_start_date', effect: 'With no start date, resmon asks bioRxiv for the 3 days before the run.' },
  ]) as Partial<CatalogEntry>);
  const ndl = entry('ndl_search', constraints([
    { applies_when: 'above_record_cap', effect: 'resmon splits your date range.' },
  ], 500) as Partial<CatalogEntry>);
  const arxiv = entry('arxiv', constraints([
    { applies_when: 'with_date_window', effect: 'arXiv dates by submission.' },
  ]) as Partial<CatalogEntry>);

  // No start date: what resmon asks bioRxiv for in its place, said before the run.
  expect(formNotices([biorxiv, ndl, arxiv], { start: false, cap: 100 })).toEqual([
    { slug: 'biorxiv', effect: 'With no start date, resmon asks bioRxiv for the 3 days before the run.' },
  ]);
  // A start date set: nothing about what resmon would have put there.
  expect(formNotices([biorxiv, ndl, arxiv], { start: true, cap: 100 })).toEqual([]);
  expect(formNotices([ndl], { start: true, cap: 600 }).map((n) => n.slug)).toEqual(['ndl_search']);
  expect(formNotices([ndl], { start: true, cap: 500 })).toEqual([]);
});

test('a watch on a person is warned only when no chosen source can be asked about one', () => {
  expect(noneAskableAboutAuthors([])).toBe(false);
  expect(noneAskableAboutAuthors([entry('biorxiv', { author: 'none' })])).toBe(true);
  expect(noneAskableAboutAuthors([entry('biorxiv', { author: 'none' }), entry('core', { author: 'unknown' })])).toBe(false);
});

test('a webhook destination stored as a URL or as one carrying its files inside', () => {
  expect(webhookTarget(' https://example.org/hook ', false)).toBe('https://example.org/hook');
  const inline = webhookTarget('https://example.org/hook', true);
  expect(JSON.parse(inline)).toEqual({ url: 'https://example.org/hook', inline: true });
  expect(webhookUrl(inline)).toBe('https://example.org/hook');
  expect(webhookUrl('https://example.org/hook')).toBe('https://example.org/hook');
  expect(webhookUrl('{not json')).toBe('no address recorded');
});

test('a window longer than a source\'s own default start says it may not be read back to its start', () => {
  const biorxiv = entry('biorxiv', {
    constraints: {
      default_start_days: 3, records_per_request: null,
      notices: [{ kind: 'date_window', applies_when: 'beyond_default_start', effect: 'resmon reads bioRxiv newest first.', established: '' }],
    },
  } as unknown as Partial<CatalogEntry>);
  const arxiv = entry('arxiv', { constraints: { default_start_days: null, records_per_request: null, notices: [] } } as unknown as Partial<CatalogEntry>);
  const said = [{ slug: 'biorxiv', effect: 'resmon reads bioRxiv newest first.' }];
  expect(formNotices([biorxiv, arxiv], { start: true, cap: 100, span: 30 })).toEqual(said);
  expect(formNotices([biorxiv], { start: true, cap: 100, span: 4 })).toEqual(said);
  // The default's own length, or none known, or no start (the default stands in): nothing.
  expect(formNotices([biorxiv], { start: true, cap: 100, span: 3 })).toEqual([]);
  expect(formNotices([biorxiv], { start: true, cap: 100, span: null })).toEqual([]);
  expect(formNotices([biorxiv], { start: false, cap: 100, span: 30 })).toEqual([]);
});

test('a source that needs a start date says what the form filled in, or why Any time is not offered', () => {
  const needs = { entries: [entry('biorxiv', { name: 'bioRxiv' }), entry('medrxiv', { name: 'medRxiv' })], days: 3 };
  const why = 'resmon reads every preprint in their ranges itself, and their whole archives are far more than a search can '
    + 'read in 45 seconds.';
  expect(askStartSentence(needs, { day: '2026-10-28', before: 'today' }))
    .toBe(`bioRxiv and medRxiv need a start date, so this search starts 3 days back, on October 28, 2026: ${why}`);
  expect(askStartSentence(needs, { day: '2026-09-28', before: 'end' }))
    .toBe(`bioRxiv and medRxiv need a start date, so this search starts on September 28, 2026, 3 days before its end date: ${why}`);
  expect(askStartSentence(needs, null))
    .toBe(`bioRxiv and medRxiv need a start date, so Any time is not offered while they are chosen: ${why}`);
});
