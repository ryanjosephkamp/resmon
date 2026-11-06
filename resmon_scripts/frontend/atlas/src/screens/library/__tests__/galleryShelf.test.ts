/**
 * The Library's gallery is drawn by virtual-core against the stage. Switching
 * to a shorter shelf after scrolling far down a long one must open the new
 * shelf at its top, and the gallery must not put the last shelf's place back
 * as it measures rows.
 */
import { Virtualizer, elementScroll, observeElementOffset } from '@tanstack/react-virtual';
import { movesStageAsGalleryMeasures } from '../Gallery';

const HIGH = 201;
const ESTIMATE = 300;

/** A stage `HIGH` pixels high that pushes its scroll back to its end when the content grows shorter, as a browser does. */
function stageFor(content: () => number) {
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

const shelf = (from: number, n: number) => Array.from({ length: n }, (_, i) => `${from + i}/4`);

describe('a shorter shelf after the gallery was scrolled far down', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  test('opens at the top, and the gallery does not put the last shelf\'s place back as it reads on', () => {
    let keys = shelf(1, 200);
    let list: Virtualizer<HTMLElement, Element> | null = null;
    const { node, clamp } = stageFor(() => list?.getTotalSize() ?? 0);
    const options = () => ({
      count: keys.length,
      getScrollElement: (): HTMLElement => node,
      estimateSize: () => ESTIMATE,
      overscan: 2,
      getItemKey: (index: number) => keys[index] ?? index,
      scrollToFn: elementScroll,
      observeElementOffset,
      observeElementRect: (_instance: unknown, done: (rect: { width: number; height: number }) => void) => {
        done({ width: 600, height: HIGH });
        return () => undefined;
      },
    });
    list = new Virtualizer<HTMLElement, Element>(options());
    list.shouldAdjustScrollPositionOnItemSizeChange = movesStageAsGalleryMeasures(node);
    list._willUpdate();

    // Far down a long shelf.
    node.scrollTop = 20_000;
    node.dispatchEvent(new Event('scroll'));
    expect(list.scrollOffset).toBe(20_000);

    // A shorter shelf is drawn at once and the stage is pushed back to its end, while the gallery still
    // reads it as 20,000 down; a row it has not drawn before is measured above that.
    keys = shelf(1_000, 30);
    list.setOptions(options());
    list.getTotalSize();
    clamp();
    const clamped = node.scrollTop;
    expect(clamped).toBeLessThan(20_000);
    list.resizeItem(10, ESTIMATE + 80);
    console.log(`gallery before the stage was reset: clamped to ${clamped}, then ${node.scrollTop} after measuring`);

    // The new shelf opens at its top; it then grows past where the old place was.
    node.scrollTop = 0;
    keys = shelf(1_000, 120);
    list.setOptions(options());
    list.getTotalSize();
    list._willUpdate();
    expect(node.scrollTop).toBe(0);
  });
});
