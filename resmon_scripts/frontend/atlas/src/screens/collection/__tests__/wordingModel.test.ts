import {
  authorsWords, comparedWords, pairLine, pairParam, percentWords, progressWords, readPair, segments,
  type SharedWordingJob,
} from '../wordingModel';

describe('a share in words', () => {
  test('is rounded down, as the engine writes it, so it never says more than was measured', () => {
    expect(percentWords(0.589)).toBe('58%');
    expect(percentWords(0.999)).toBe('99%');
    expect(percentWords(1)).toBe('100%');
    expect(percentWords(0.004)).toBe('under 1%');
    expect(percentWords(0)).toBe('0%');
    // 0.29 * 100 is 28.999999999999996 in floating point; it is still 29%.
    expect(percentWords(0.29)).toBe('29%');
  });
});

describe('a pair in the address', () => {
  test('is the lower number first, either way it was opened', () => {
    expect(pairParam(345, 12)).toBe('12-345');
    expect(readPair('345-12')).toEqual([12, 345]);
  });

  test('is nothing when it is not two different paper numbers', () => {
    for (const value of [null, '', '12', '12-12', '12-x', '-1-2', '0-3']) expect(readPair(value)).toBeNull();
  });
});

describe('the words of a pair', () => {
  test('say what was measured and never why', () => {
    const line = pairLine({ longest: 64, share: 0.583, authors_in_common: 0, category: 'different_authors' }, 8);
    expect(line).toBe("64-word passage word for word · 58% of the shorter abstract's 8-word phrases · no author in common");
    for (const banned of ['plagiar', 'copied', 'stolen', 'original']) expect(line.toLowerCase()).not.toContain(banned);
  });

  test('do not say "no author in common" when a record lists none', () => {
    expect(authorsWords('authors_unknown', 0)).toBe('authors not listed on one record');
    expect(authorsWords('same_authors', 2)).toBe('2 authors in common');
  });

  test('count what the scan did not compare, by reason, with the minimum stated', () => {
    const scan = {
      kind: 'full', started_at: null, finished_at: null, seconds: 1, full_scan_at: null, considered: 16061,
      compared: 12294, not_compared: { no_abstract: 3078, too_short: 689 }, method_version: 1,
    };
    expect(comparedWords(scan, 40)).toBe(
      '12,294 abstracts were compared. 3,078 papers have no abstract and 689 papers have abstracts under 40 words, '
      + 'so those 3,767 were not compared.');
  });

  test('say which pass is running and how far it is', () => {
    const job: SharedWordingJob = {
      running: true, kind: 'new', stage: 'reading', done: 2000, total: 16061, started_at: null, finished_at: null,
      cancelled: false, error: null, found: null,
    };
    expect(progressWords(job)).toBe('Comparing new papers with the collection: reading 2,000 of 16,061 papers.');
    expect(progressWords({ ...job, kind: 'full', stage: 'measuring', done: 10, total: 420 }))
      .toBe('Scanning the collection: measuring 10 of 420 pairs that share phrases.');
  });
});

describe('a text cut at its passages', () => {
  test('marks each passage and leaves the rest plain, joining the pieces back to the text', () => {
    const text = 'one two three four five six';
    const cut = segments(text, [{ start: 4, end: 13, passage: 0 }]);
    expect(cut).toEqual([
      { text: 'one ', passages: [] },
      { text: 'two three', passages: [0] },
      { text: ' four five six', passages: [] },
    ]);
    expect(cut.map((s) => s.text).join('')).toBe(text);
  });

  test('lists every passage a stretch is in where two overlap', () => {
    const cut = segments('abcdefghij', [{ start: 0, end: 6, passage: 0 }, { start: 4, end: 10, passage: 1 }]);
    expect(cut).toEqual([
      { text: 'abcd', passages: [0] },
      { text: 'ef', passages: [0, 1] },
      { text: 'ghij', passages: [1] },
    ]);
  });

  test('counts in codepoints, as the engine does, so a character outside the BMP does not shift a mark', () => {
    // "𝒳" is one codepoint and two UTF-16 units.
    const text = '𝒳 shared words here';
    const cut = segments(text, [{ start: 2, end: 14, passage: 0 }]);
    expect(cut[1]).toEqual({ text: 'shared words', passages: [0] });
  });
});
