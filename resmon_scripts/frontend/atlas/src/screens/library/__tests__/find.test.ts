import { findHits, findPattern, findText, firstFrom, fold, ordinal, readingOrder, step, type Run } from '../findModel';

/** A page as PDF.js gives it: lines of runs, the last run of each line ending it. */
const page = (...lines: string[][]): Run[] => lines.flatMap((runs) => runs.map((str, i) => ({ str, hasEOL: i === runs.length - 1 })));

/** The text of each match, read back from the runs it spans. */
function matched(runs: Run[], query: string): string[] {
  const text = findText(runs);
  return findHits(text, findPattern(query)!).map((hit) => {
    let out = '';
    for (let r = hit.from[0]; r <= hit.to[0]; r += 1) {
      const str = runs[r]!.str;
      out += str.slice(r === hit.from[0] ? hit.from[1] : 0, r === hit.to[0] ? hit.to[1] : str.length);
      if (r < hit.to[0] && runs[r]!.hasEOL) out += '\n';
    }
    return out;
  });
}

test('a match spans runs and lines, and is given back as the runs it covers', () => {
  const runs = page(['A phrase that ', 'runs across'], ['two lines, and a hyphen-'], ['ated word ends the page.']);
  expect(matched(runs, 'runs across two lines')).toEqual(['runs across\ntwo lines']);
  expect(matched(runs, 'that runs')).toEqual(['that runs']);
  const hit = findHits(findText(runs), findPattern('across two')!)[0]!;
  expect(hit).toEqual({ from: [1, 5], to: [2, 3] });
});

test('a word broken at a line-ending hyphen is found whole, and with its hyphen', () => {
  const runs = page(['a hyphen-'], ['ated word']);
  expect(matched(runs, 'hyphenated')).toEqual(['hyphen-\nated']);
  expect(matched(runs, 'hyphen-ated')).toEqual(['hyphen-\nated']);
  // A hyphen inside a line is a hyphen: it is not dropped.
  expect(matched(page(['state-of-the-art']), 'stateofthe')).toEqual([]);
  expect(matched(page(['state-of-the-art']), 'state-of')).toEqual(['state-of']);
});

test('case, accents, ligatures and runs of whitespace are ignored; every other character must match', () => {
  const runs = page(['Résumé of the ', 'ﬁrst   EFFECT'], ['and more']);
  expect(matched(runs, 'resume')).toEqual(['Résumé']);
  expect(matched(runs, 'first effect')).toEqual(['ﬁrst   EFFECT']);
  expect(matched(runs, 'EFFECT and')).toEqual(['EFFECT\nand']);
  expect(matched(runs, 'resumes')).toEqual([]);
  expect(matched(runs, '(of)')).toEqual([]);
  expect(findPattern('   ')).toBeNull();
  expect(fold('‐')).toBe('-');
  // Words a PDF sets apart without a space are still found as two.
  expect(matched(page(['words', 'apart']), 'words apart')).toEqual(['wordsapart']);
});

test('every match on a page, in order, none overlapping', () => {
  expect(matched(page(['aaaa a']), 'aa')).toEqual(['aa', 'aa']);
  expect(matched(page(['one page, two pages'], ['three PAGES']), 'page')).toEqual(['page', 'page', 'PAGE']);
});

test('a page with no text, or text before any run, is safe', () => {
  expect(findHits(findText([]), findPattern('x')!)).toEqual([]);
  expect(matched(page([''], ['  x']), 'x')).toEqual(['x']);
});

test('the count and the place in it run in page order, whatever order the pages were read in', () => {
  const counts = new Map([[7, 2], [3, 1], [12, 0], [9, 3]]);
  expect(ordinal(counts, 3, 0)).toEqual({ n: 1, of: 6 });
  expect(ordinal(counts, 7, 1)).toEqual({ n: 3, of: 6 });
  expect(ordinal(counts, 9, 2)).toEqual({ n: 6, of: 6 });
});

test('stepping goes through every match and wraps at either end', () => {
  const counts = new Map([[3, 1], [7, 2], [12, 0]]);
  expect(step(counts, { page: 3, index: 0 }, 1)).toEqual({ page: 7, index: 0 });
  expect(step(counts, { page: 7, index: 0 }, 1)).toEqual({ page: 7, index: 1 });
  expect(step(counts, { page: 7, index: 1 }, 1)).toEqual({ page: 3, index: 0 });
  expect(step(counts, { page: 3, index: 0 }, -1)).toEqual({ page: 7, index: 1 });
  expect(step(counts, { page: 7, index: 1 }, -1)).toEqual({ page: 7, index: 0 });
  expect(step(counts, null, -1)).toEqual({ page: 7, index: 1 });
  expect(step(new Map([[1, 0]]), null, 1)).toBeNull();
  expect(firstFrom(counts, 5)).toEqual({ page: 7, index: 0 });
  expect(firstFrom(counts, 8)).toEqual({ page: 3, index: 0 });
});

test('pages are read from the one on screen to the end, then from the start', () => {
  expect(readingOrder(5, 3)).toEqual([3, 4, 5, 1, 2]);
  expect(readingOrder(3, 1)).toEqual([1, 2, 3]);
  expect(readingOrder(3, 9)).toEqual([3, 1, 2]);
});
