import { cleanTerm, matchOf, splitQuery, storedTerms, termsInWords } from '../terms';

describe('a stored search’s terms, read the way the engine reads them', () => {
  test('a keyword list is the terms, and matches any term unless All is stored', () => {
    expect(storedTerms({ keywords: ['splats', 'gaussian splatting'] })).toEqual({ keywords: ['splats', 'gaussian splatting'], match: 'any' });
    expect(storedTerms({ keywords: ['QR', 'prose'], match: 'all' })).toEqual({ keywords: ['QR', 'prose'], match: 'all' });
    expect(storedTerms({ keywords: ['', ' '], query: '' })).toEqual({ keywords: [], match: 'any' });
  });

  test('a stored query alone is its words and quoted phrases, every one required', () => {
    expect(storedTerms({ query: 'splats "gaussian splatting"' })).toEqual({ keywords: ['splats', 'gaussian splatting'], match: 'all' });
    expect(storedTerms({ query: 'graph neural', match: 'any' }).match).toBe('any');
  });

  test('stop words between other words are left out, as the engine leaves them out', () => {
    expect(splitQuery('theory of mind')).toEqual(['theory', 'mind']);
    expect(splitQuery('"theory of mind"')).toEqual(['theory of mind']);
    expect(splitQuery('the')).toEqual(['the']);
  });

  test('quote marks are not searched for, and spaces collapse', () => {
    expect(cleanTerm('  “deep   learning” ')).toBe('deep learning');
    expect(matchOf('some')).toBe('any');
    expect(matchOf(undefined, 'all')).toBe('all');
  });
});

test('terms in words, joined by how they combine, with the serial comma', () => {
  expect(termsInWords(['splats'], 'any')).toBe('“splats”');
  expect(termsInWords(['splats', 'gaussian splatting'], 'any')).toBe('“splats” or “gaussian splatting”');
  expect(termsInWords(['QR', 'prose'], 'all')).toBe('“QR” and “prose”');
  expect(termsInWords(['a1', 'b2', 'c3'], 'any')).toBe('“a1”, “b2”, or “c3”');
  expect(termsInWords([], 'any')).toBe('');
});
