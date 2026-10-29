import type { CatalogEntry } from '../../runs/model';
import { webhookTarget } from '../../watches/Destinations';
import { webhookUrl } from '../../watches/model';
import { coarseFor, coarseSentence, noneAskableAboutAuthors, paceOf, rateLong, rateShort, ratePerSecond } from '../catalog';

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
