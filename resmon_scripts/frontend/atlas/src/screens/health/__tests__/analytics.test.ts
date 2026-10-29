import {
  collectionFor, daysWords, groupTotals, monthShort, monthWords, percent, watchStatusWords, widthOf,
} from '../analyticsModel';

test('a share over too little is a dash, never 0%', () => {
  expect(percent(null)).toBe('—');
  expect(percent(undefined)).toBe('—');
  expect(percent(0)).toBe('0%');
  expect(percent(0.4267)).toBe('43%');
});

test('a width is a part of the widest row, and nothing is drawn for nothing', () => {
  expect(widthOf(5, 10)).toBe(50);
  expect(widthOf(0, 10)).toBe(0);
  expect(widthOf(1, 1000)).toBe(0.5);
  expect(widthOf(3, 0)).toBe(0);
});

test('a calendar month is read in no time zone', () => {
  expect(monthWords('2026-01')).toBe('Jan 2026');
  expect(monthShort('2026-10')).toBe('Oct ’26');
  expect(monthWords('not a month')).toBe('not a month');
});

test('days in words, including a source that dates a paper after resmon saw it', () => {
  expect(daysWords(null)).toBe('—');
  expect(daysWords(0.4)).toBe('under a day');
  expect(daysWords(1)).toBe('1 day');
  expect(daysWords(12.25)).toBe('12.3 days');
  expect(daysWords(-2.25)).toBe('2.3 days before its stated date');
});

test('a watch\'s status says the count it rests on', () => {
  expect(watchStatusWords({ status: 'healthy', runs_since_new: 0, runs: 9 }, 3, 3)).toBe('New papers within its last 3 runs');
  expect(watchStatusWords({ status: 'stale', runs_since_new: 4, runs: 9 }, 3, 3)).toBe('Nothing new in its last 4 runs');
  expect(watchStatusWords({ status: 'insufficient_data', runs_since_new: 0, runs: 1 }, 3, 3))
    .toBe('1 of the 3 completed runs needed to judge');
  expect(watchStatusWords({ status: 'something_new', runs_since_new: 0, runs: 1 }, 3, 3)).toBe('something_new');
});

test('a chart\'s row opens the collection narrowed to it', () => {
  expect(collectionFor({ source: 'arxiv' })).toBe('/search?source=arxiv');
  expect(collectionFor({ category: 'cs.LG' })).toBe('/search?category=cs.LG');
});

test('groups over a window, largest first, and everything else last', () => {
  const totals = groupTotals([
    { month: '2026-09', total: 5, groups: { arxiv: 3, other: 2 } },
    { month: '2026-10', total: 6, groups: { arxiv: 1, crossref: 5 } },
  ]);
  expect(totals).toEqual([{ group: 'crossref', total: 5 }, { group: 'arxiv', total: 4 }, { group: 'other', total: 2 }]);
});
