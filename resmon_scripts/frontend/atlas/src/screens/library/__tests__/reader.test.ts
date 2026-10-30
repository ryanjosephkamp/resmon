import { Drawer } from '../pdfDocument';
import {
  CSS_UNITS, PAGE_GAP, PAGE_PAD, anchorAt, currentPage, explicitDest, findSelection, keptPages, layout, linkBox, linkTarget,
  stepZoom, topOf, webHref, zoomPercent, zoomScale,
} from '../readerModel';

const LETTER = { width: 612, height: 792 };
const LINK = 2;

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
    expect(findSelection(text, 'hyphenated word')).toBeNull();
  });
  test('every other character must be the same, and a repeat is counted', () => {
    expect(findSelection(text, 'first line')).toBeNull();
    expect(findSelection(text, 'second line')).toEqual({ start: 26, end: 37, count: 2 });
    expect(findSelection(text, '(.*)')).toBeNull();
    expect(findSelection(text, '   ')).toBeNull();
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
