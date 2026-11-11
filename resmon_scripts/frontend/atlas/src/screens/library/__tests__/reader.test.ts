import { Drawer } from '../pdfDocument';
import {
  CSS_UNITS, FOCUS_ZOOM, OPENING_ZOOM, PAGE_GAP, PAGE_PAD, allot, anchorAt, currentPage, explicitDest, findSelection, keptPages, layout,
  linkBox, linkTarget, literalMatches, stepMatch, stepZoom, topOf, webHref, zoomPercent, zoomScale,
} from '../readerModel';

const LETTER = { width: 612, height: 792 };
const LINK = 2;

test('the reader opens at fit width beside the notes, and focus mode at fit page, the whole page in the window', () => {
  expect(OPENING_ZOOM).toBe('width');
  expect(FOCUS_ZOOM).toBe('page');
  // A focus-mode window on a 1024 by 768 screen: the whole Letter page fits it, top to bottom.
  const window = { width: 1024, height: 700 };
  const scale = zoomScale(FOCUS_ZOOM, window, LETTER);
  expect(LETTER.height * scale).toBeLessThanOrEqual(window.height - 2 * PAGE_PAD);
  expect(LETTER.width * scale).toBeLessThanOrEqual(window.width - 2 * PAGE_PAD);
});

test('a zoom is a scale: 100% is actual size, fit width fills the frame, fit page shows the whole page', () => {
  expect(zoomScale(100, { width: 500, height: 500 }, LETTER)).toBeCloseTo(CSS_UNITS);
  const frame = { width: 1000, height: 600 };
  expect(zoomScale('width', frame, LETTER)).toBeCloseTo((1000 - 2 * PAGE_PAD) / 612);
  expect(zoomScale('page', frame, LETTER)).toBeCloseTo((600 - 2 * PAGE_PAD) / 792);
  expect(zoomPercent(zoomScale(150, frame, LETTER))).toBe(150);
  // Fit width here is 119%: the steps either side of it.
  expect(zoomPercent(zoomScale('width', frame, LETTER))).toBe(119);
  expect(stepZoom(zoomScale('width', frame, LETTER), 1)).toBe(125);
  expect(stepZoom(zoomScale('width', frame, LETTER), -1)).toBe(100);
  expect(stepZoom(zoomScale(300, frame, LETTER), 1)).toBe(300);
  expect(stepZoom(zoomScale(50, frame, LETTER), -1)).toBe(50);
});

test('pages stack top to bottom with a gap, each where the one before it ends', () => {
  const view = layout([LETTER, { width: 792, height: 612 }, LETTER], 1);
  expect(view.tops).toEqual([PAGE_PAD, PAGE_PAD + 792 + PAGE_GAP, PAGE_PAD + 792 + PAGE_GAP + 612 + PAGE_GAP]);
  expect(view.height).toBe(view.tops[2]! + 792 + PAGE_PAD);
  expect(view.width).toBe(792 + 2 * PAGE_PAD);
});

test('the page on screen is the one most in view; at the very end of the scroll it is the last', () => {
  const view = layout(Array.from({ length: 10 }, () => LETTER), 1);
  expect(currentPage(view, 0, 700)).toBe(1);
  expect(currentPage(view, view.tops[4]! - PAGE_GAP, 700)).toBe(5);
  // Half of page 3 and half of page 4: the first of equals.
  expect(currentPage(view, view.tops[2]! + 396, 792 + PAGE_GAP)).toBe(3);
  expect(currentPage(view, view.height - 1000, 1000)).toBe(10);
  // Everything in view and nothing scrolled: not "the end".
  const short = layout([LETTER, LETTER], 0.3);
  expect(currentPage(short, 0, 2000)).toBe(1);
});

test('only the pages near the view are kept, and a kept page is let go only once it is well away', () => {
  const view = layout(Array.from({ length: 500 }, () => LETTER), 1);
  const height = 800;
  const at = (page: number) => view.tops[page - 1]!;
  // 0-based indexes: page 100 is index 99, and a screen either side of it is kept.
  const kept = keptPages(view, at(100), height, null);
  expect(kept[0]).toBeLessThanOrEqual(98);
  expect(kept[1]).toBeGreaterThanOrEqual(100);
  expect(kept[1] - kept[0] + 1).toBeLessThanOrEqual(24);
  // A little further: what was kept stays kept.
  const next = keptPages(view, at(101), height, kept);
  expect(next[0]).toBe(kept[0]);
  // Far away: the old pages go.
  const far = keptPages(view, at(300), height, next);
  expect(far[0]).toBeGreaterThan(290);
  // Zoomed far out, many pages fit a screen, and still no more than the cap are kept.
  const tiny = layout(Array.from({ length: 500 }, () => LETTER), 0.05);
  const many = keptPages(tiny, 0, 2000, null, 24);
  expect(many[1] - many[0] + 1).toBe(24);
});

test('pages in view are drawn at the display’s density; the farthest are drawn at half, then not at all, to stay in budget', () => {
  // Focus mode at fit width on a 1728-point 2× display: Letter pages 1696 × 2194 CSS pixels, 14.9 million canvas pixels each.
  const view = layout(Array.from({ length: 40 }, () => LETTER), 1696 / 612);
  const full = view.widths[0]! * 2 * view.heights[0]! * 2;
  const budget = 4 * full + 1;
  const d = allot(view, [8, 15], [10, 11], 2, 2 ** 25, budget);
  expect([d.get(10), d.get(11)]).toEqual([2, 2]);
  // Two more fit at full: the next page down first, then the one above.
  expect([d.get(12), d.get(9)]).toEqual([2, 2]);
  // Then half, while it fits; then none. Never sharper than a nearer page.
  const given = [13, 8, 14, 15].map((i) => d.get(i)!);
  expect(given.every((x, n) => n === 0 || x <= given[n - 1]!)).toBe(true);
  expect(given).toContain(0);
  let spent = 0;
  for (const [i, x] of d) spent += x ? view.widths[i]! * x * view.heights[i]! * x : 0;
  expect(spent).toBeLessThanOrEqual(budget);
  // Pages in view are drawn sharp even past the budget.
  const tight = allot(view, [8, 15], [10, 11], 2, 2 ** 25, 1);
  expect([tight.get(10), tight.get(11), tight.get(9), tight.get(12)]).toEqual([2, 2, 0, 0]);
  // At the reader's size beside the notes, the budget never binds.
  const small = layout(Array.from({ length: 40 }, () => LETTER), 0.69);
  const all = allot(small, [0, 23], [3, 4], 2, 2 ** 25, 2 ** 26);
  expect(Array.from(all.values()).every((x) => x === 2)).toBe(true);
});

test('a new layout keeps the same part of the same page at the top of the view', () => {
  const small = layout(Array.from({ length: 20 }, () => LETTER), 0.5);
  const anchor = anchorAt(small, small.tops[7]! + small.heights[7]! / 4);
  expect(anchor.index).toBe(7);
  expect(anchor.fraction).toBeCloseTo(0.25);
  const large = layout(Array.from({ length: 20 }, () => LETTER), 2);
  expect(topOf(large, anchor)).toBeCloseTo(large.tops[7]! + large.heights[7]! / 4);
});

test('a link to the web opens only for http and https; nothing else a link can do is followed but a page', () => {
  const rect = [0, 0, 10, 10];
  expect(linkTarget({ annotationType: LINK, rect, url: 'https://example.org/a' }, LINK)).toEqual({ kind: 'web', href: 'https://example.org/a' });
  expect(linkTarget({ annotationType: LINK, rect, url: 'http://example.org/' }, LINK)).toEqual({ kind: 'web', href: 'http://example.org/' });
  for (const url of ['mailto:a@example.org', 'file:///etc/passwd', 'javascript:alert(1)', 'tel:123', 'ftp://example.org/', 'not a url']) {
    expect(linkTarget({ annotationType: LINK, rect, url }, LINK)).toBeNull();
  }
  // An address PDF.js refused is not followed by its destination either.
  expect(linkTarget({ annotationType: LINK, rect, url: 'mailto:a@example.org', dest: 'chapter' }, LINK)).toBeNull();
  expect(linkTarget({ annotationType: LINK, rect, attachment: { filename: 'x.exe' }, dest: 'chapter' }, LINK)).toBeNull();
  expect(linkTarget({ annotationType: LINK, rect, action: 'Print' }, LINK)).toBeNull();
  expect(linkTarget({ annotationType: LINK, rect, action: 'NextPage' }, LINK)).toEqual({ kind: 'page', action: 'NextPage' });
  expect(linkTarget({ annotationType: LINK, rect, dest: 'chapter' }, LINK)).toEqual({ kind: 'dest', dest: 'chapter' });
  expect(linkTarget({ annotationType: LINK, rect }, LINK)).toBeNull();
  expect(linkTarget({ annotationType: 20, rect, url: 'https://example.org/' }, LINK)).toBeNull();
  expect(webHref('HTTPS://Example.org')).toBe('https://example.org/');
});

test('an explicit destination names its page and, where it says, the height on it', () => {
  expect(explicitDest([{ num: 12, gen: 0 }, { name: 'XYZ' }, 0, 500, 0])).toEqual({ ref: { num: 12, gen: 0 }, index: null, top: 500 });
  expect(explicitDest([3, { name: 'FitH' }, 640])).toEqual({ ref: null, index: 3, top: 640 });
  expect(explicitDest([{ num: 1, gen: 0 }, { name: 'Fit' }])).toEqual({ ref: { num: 1, gen: 0 }, index: null, top: null });
  expect(explicitDest(['nowhere', { name: 'XYZ' }])).toBeNull();
  expect(explicitDest([-1, { name: 'XYZ' }])).toBeNull();
});

test('a link is placed in proportions of its page, whichever corners it names', () => {
  expect(linkBox([300, 100, 100, 50], { width: 400, height: 200 })).toEqual({ left: 25, top: 25, width: 50, height: 25 });
  expect(linkBox([-10, -10, 1000, 1000], { width: 400, height: 200 })).toEqual({ left: 0, top: 0, width: 100, height: 100 });
});

describe('text selected on the drawn page, found in the page’s text', () => {
  const text = 'First line of the page.\nA second line with a hyphen-\nated word, and the second line again.';
  test('line breaks and runs of spaces in the selection match any whitespace', () => {
    expect(findSelection(text, 'of the page. A  second')).toEqual({ start: 11, end: 32, count: 1 });
    expect(text.slice(11, 32)).toBe('of the page.\nA second');
  });
  test('a word broken at its hyphen matches with or without the break, and the hyphen is kept', () => {
    const at = findSelection(text, 'hyphen-\nated word')!;
    expect(text.slice(at.start, at.end)).toBe('hyphen-\nated word');
    const joined = findSelection(text, 'hyphenated word')!;
    expect(text.slice(joined.start, joined.end)).toBe('hyphen-\nated word');
    expect(joined.count).toBe(1);
  });
  test('every other character must be the same, and a repeat is counted', () => {
    expect(findSelection(text, 'first line')).toBeNull();
    expect(findSelection(text, 'second line')).toEqual({ start: 26, end: 37, count: 2 });
    expect(findSelection(text, '(.*)')).toBeNull();
    expect(findSelection(text, '   ')).toBeNull();
  });

  // pypdf drops the space where the font changes to bold or italic, and keeps a line-end hyphen.
  const engine = 'Abstract\nWe presentUltraVoxelGS, a 3D ultrasound reconstruction method that achieves\n'
    + 'bothfast reconstructionand physicallyfaithful renderingfor the first time, bring-\n'
    + 'ing live spatial feedback during 2D ultrasound scanning within reach.';
  test('a selection is kept where the engine’s text lost the spaces around bold and italic words', () => {
    const drawn = 'We present UltraVoxelGS, a 3D ultrasound reconstruction method that achieves\n'
      + 'both fast reconstruction and physically faithful rendering for the first time, bring-\n'
      + 'ing live spatial feedback during 2D ultrasound scanning within reach.';
    const at = findSelection(engine, drawn)!;
    expect(at.count).toBe(1);
    // The range is the engine's own text, from the first letter selected to the last.
    expect(engine.slice(at.start, at.end)).toBe(engine.slice('Abstract\n'.length));
    const middle = findSelection(engine, 'both fast reconstruction and')!;
    expect(engine.slice(middle.start, middle.end)).toBe('bothfast reconstructionand');
  });
  test('a line-end hyphen in the engine’s text matches a selection that joins the word', () => {
    const at = findSelection(engine, 'bringing live spatial')!;
    expect(engine.slice(at.start, at.end)).toBe('bring-\ning live spatial');
    // A hyphen inside a line is a character like any other.
    expect(findSelection('a feed-forward design', 'feedforward design')).toBeNull();
  });
  test('ligatures are spelled out on either side, and the range covers the whole ligature', () => {
    const ligated = 'the \uFB01rst e\uFB03cient \uFB02ow';
    const at = findSelection(ligated, 'first efficient flow')!;
    expect(ligated.slice(at.start, at.end)).toBe(ligated.slice(4));
    const half = findSelection(ligated, 'irst')!;
    expect(ligated.slice(half.start, half.end)).toBe('\uFB01rst');
    const spelled = findSelection('the first efficient flow', 'e\uFB03cient')!;
    expect(spelled).toEqual({ start: 10, end: 19, count: 1 });
  });
  test('a range never starts or ends on whitespace or inside a surrogate pair', () => {
    const math = 'let \u{1D6FC}be small, and \u{1D6FC} be large';
    const at = findSelection(math, '\u{1D6FC} be small')!;
    expect(math.slice(at.start, at.end)).toBe('\u{1D6FC}be small');
    expect(at.start).toBe(4);
    const tail = findSelection(math, 'small, and ')!;
    expect(math.slice(tail.start, tail.end)).toBe('small, and');
  });
  test('letters in the text more than once are counted, and a selection not in the text is still refused', () => {
    expect(findSelection('one twothree, one two three', 'one two three')).toEqual({ start: 14, end: 27, count: 1 });
    expect(findSelection('one twothree, onetwo three', 'one two three')).toEqual({ start: 0, end: 12, count: 2 });
    expect(findSelection(engine, 'We present UltraVoxelGS, a 4D ultrasound')).toBeNull();
    expect(findSelection(engine, 'within reach!')).toBeNull();
  });
});

test('the drawer runs the nearest job first, a few at a time, and withdraws a job no longer wanted', async () => {
  const drawer = new Drawer(1);
  const order: number[] = [];
  let release: () => void = () => undefined;
  const block = new Promise<void>((resolve) => { release = resolve; });
  drawer.schedule(async () => { order.push(0); await block; }, () => 0);
  const ranks = new Map([[5, 5], [1, 1], [3, 3]]);
  for (const id of [5, 1, 3]) drawer.schedule(async () => { order.push(id); }, () => ranks.get(id)!);
  const withdraw = drawer.schedule(async () => { order.push(2); }, () => 2);
  withdraw();
  // Asked when a slot frees, not when queued: page 5 is now the nearest.
  ranks.set(5, 0);
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(order).toEqual([0, 5, 1, 3]);
  let aborted = false;
  drawer.schedule(async (signal) => { await new Promise((resolve) => setTimeout(resolve, 5)); aborted = signal.aborted; }, () => 0);
  drawer.stop();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(aborted).toBe(true);
});

describe('find on a page\'s text steps through its matches, as the PDF\'s find does', () => {
  const TEXT = 'The wombat dug. A second wombat slept.';
  const all = literalMatches(TEXT, 'wombat');
  const at = (i: number) => ({ start: all[i]!, end: all[i]! + 'wombat'.length });

  test('every literal match, in order, each after the one before it ends', () => {
    expect(all).toEqual([4, 25]);
    expect(literalMatches('aaaa', 'aa')).toEqual([0, 2]);
    expect(literalMatches(TEXT, 'Wombat')).toEqual([]);
    expect(literalMatches(TEXT, '')).toEqual([]);
  });

  test('Enter goes to the next and Shift+Enter to the previous, wrapping at either end', () => {
    const nothing = { start: 0, end: 0 };
    expect(stepMatch(all, 6, nothing, false)).toBe(0);
    expect(stepMatch(all, 6, at(0), false)).toBe(1);
    expect(stepMatch(all, 6, at(1), false)).toBe(0);
    expect(stepMatch(all, 6, at(1), true)).toBe(0);
    expect(stepMatch(all, 6, at(0), true)).toBe(1);
    expect(stepMatch(all, 6, nothing, true)).toBe(1);
  });

  test('from a selection that is not a match, it goes from where the selection is', () => {
    expect(stepMatch(all, 6, { start: 10, end: 14 }, false)).toBe(1);
    expect(stepMatch(all, 6, { start: 10, end: 14 }, true)).toBe(0);
    expect(stepMatch(all, 6, { start: 30, end: 30 }, false)).toBe(0);
    // Words made longer keep the place: the match that begins where the shorter one did.
    expect(stepMatch(all, 6, { start: 25, end: 28 }, false)).toBe(1);
  });
});
