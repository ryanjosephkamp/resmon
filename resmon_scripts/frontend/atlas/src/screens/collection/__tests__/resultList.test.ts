/**
 * Search's results are drawn by virtual-core in a box of their own. A new
 * search opens them at the top; the list must not then carry the last
 * search's place back into the new one.
 */
import { Virtualizer, elementScroll, observeElementOffset } from '@tanstack/react-virtual';
import { movesBoxAsItMeasures } from '../ResultList';

const HIGH = 201;
const ESTIMATE = 78;

/**
 * A box `HIGH` pixels high whose content is the list's height, which pushes its
 * scroll back to its end when the list grows shorter than it, as a browser does.
 */
function boxFor(content: () => number) {
  const node = document.createElement('div');
  let top = 0;
  const max = () => Math.max(0, content() - HIGH);
  Object.defineProperty(node, 'scrollTop', { get: () => top, set: (value: number) => { top = Math.max(0, Math.min(value, max())); } });
  Object.defineProperty(node, 'scrollHeight', { get: () => Math.max(content(), HIGH) });
  Object.defineProperty(node, 'clientHeight', { get: () => HIGH });
  node.scrollTo = ((options: ScrollToOptions) => { node.scrollTop = options.top ?? top; }) as typeof node.scrollTo;
  document.body.append(node);
  return { node, clamp: () => { top = Math.min(top, max()); } };
}

/** The papers a search lists, by id. */
const papers = (from: number, n: number) => Array.from({ length: n }, (_, i) => from + i);

describe('a new search after the list was scrolled far down', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  test('opens at the top, and the list does not put the last search\'s place back as it reads on', () => {
    let ids = papers(1, 420);
    let list: Virtualizer<HTMLElement, Element> | null = null;
    const { node, clamp } = boxFor(() => list?.getTotalSize() ?? 0);
    const options = () => ({
      count: ids.length,
      getScrollElement: (): HTMLElement => node,
      estimateSize: () => ESTIMATE,
      overscan: 10,
      getItemKey: (index: number) => ids[index] ?? index,
      scrollToFn: elementScroll,
      observeElementOffset,
      observeElementRect: (_instance: unknown, done: (rect: { width: number; height: number }) => void) => {
        done({ width: 600, height: HIGH });
        return () => undefined;
      },
    });
    list = new Virtualizer<HTMLElement, Element>(options());
    list.shouldAdjustScrollPositionOnItemSizeChange = movesBoxAsItMeasures(node);
    list._willUpdate();

    // The person scrolls far down the first search's 420 papers.
    node.scrollTop = 5_198;
    node.dispatchEvent(new Event('scroll'));
    expect(list.scrollOffset).toBe(5_198);

    // A new search whose first 60 papers were read before: the list is drawn at once, shorter, and the
    // box is pushed back to its end. The list still reads the box as 5,198 down until the box says it
    // has moved, and measures a paper it has not drawn before, above that.
    ids = papers(1_000, 60);
    list.setOptions(options());
    list.getTotalSize();
    clamp();
    expect(node.scrollTop).toBeLessThan(5_198);
    list.resizeItem(50, ESTIMATE + 42);

    // The new search opens at its top.
    node.scrollTop = 0;
    // The next page is read, and the list grows past where it was.
    ids = papers(1_000, 120);
    list.setOptions(options());
    list.getTotalSize();
    list._willUpdate();
    expect(node.scrollTop).toBe(0);
  });
});
