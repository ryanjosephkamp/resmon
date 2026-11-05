/**
 * The stage's place on each history entry: a new screen opens at its top,
 * Back and Forward put a screen back where it was left (by the row that was at
 * its top, where there is one), a change of address within one screen leaves
 * it where it is, and a screen that opens at its own place keeps it.
 */
import { useEffect, useRef } from 'react';
import { act, render } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate, type NavigateFunction } from 'react-router-dom';
import { SCROLL_LIMIT, ScrollMemory, StageScroll, anchorAt, landing, placeStage, type Place } from '../stageScroll';

const at = (top: number): Place => ({ top, anchor: null });

describe('where the stage goes when the page changes', () => {
  test('another screen opens at its top, by a link, a tab, a command, or Back to an entry with nothing kept', () => {
    expect(landing('PUSH', '/runs', '/health/analytics', null)).toEqual(at(0));
    expect(landing('REPLACE', '/runs', '/today', null)).toEqual(at(0));
    expect(landing('POP', '/runs', '/today', null)).toEqual(at(0));
  });

  test('Back and Forward put an entry back where it was left, on the same screen too', () => {
    expect(landing('POP', '/health/analytics', '/runs', at(2400))).toEqual(at(2400));
    expect(landing('POP', '/search/wording', '/search/wording', at(610))).toEqual(at(610));
  });

  test('a new address within one screen (a filter, a shelf, a panel over a list) leaves it where it is', () => {
    expect(landing('PUSH', '/search/wording', '/search/wording', null)).toBe('keep');
    expect(landing('REPLACE', '/library', '/library', null)).toBe('keep');
    expect(landing('POP', '/library', '/library', null)).toBe('keep');
  });
});

describe('the places kept', () => {
  test('each under its entry, put back only on the address it was left on', () => {
    const memory = new ScrollMemory();
    memory.write('abc', '/runs', at(900));
    expect(memory.read('abc', '/runs')).toEqual(at(900));
    // The key every entry the router did not make shares: another address there is not this place.
    memory.write('default', '/today', at(300));
    expect(memory.read('default', '/runs')).toBeNull();
    expect(memory.read('nope', '/runs')).toBeNull();
  });

  test('bounded, the longest untouched going first', () => {
    const memory = new ScrollMemory(2);
    memory.write('a', '/a', at(1));
    memory.write('b', '/b', at(2));
    memory.write('a', '/a', at(3));
    memory.write('c', '/c', at(4));
    expect(memory.size).toBe(2);
    expect(memory.read('b', '/b')).toBeNull();
    expect(memory.read('a', '/a')).toEqual(at(3));
    expect(SCROLL_LIMIT).toBeGreaterThanOrEqual(100);
  });
});

/** Give an element a box, as jsdom lays nothing out. */
function box(node: Element, top: number, height = 70) {
  node.getBoundingClientRect = () => ({ top, bottom: top + height, left: 0, right: 600, width: 600, height, x: 0, y: top, toJSON: () => ({}) });
}

describe('the row at the top', () => {
  afterEach(() => { delete (document as { elementFromPoint?: unknown }).elementFromPoint; });

  test('is the nearest row known by what it is and found once, past a mark that shows up in every row', () => {
    const stage = document.createElement('main');
    stage.innerHTML = `
      <div class="bar">filters</div>
      <article data-run="190"><span data-source="arxiv">arXiv</span> run 0189</article>
      <article data-run="189"><span data-source="arxiv">arXiv</span> run 0188</article>`;
    document.body.append(stage);
    box(stage, 52, 800);
    const [bar, first] = [stage.querySelector('.bar')!, stage.querySelector('[data-run="190"]')!];
    box(first, 30);
    // A bar held at the top covers the first height; the next one finds the run's source mark, which is in every run.
    document.elementFromPoint = (_x: number, y: number) => (y < 100 ? bar : first.querySelector('span'));
    expect(anchorAt(stage)).toEqual({ selector: '[data-run="190"]', offset: -22 });
    document.elementFromPoint = () => bar;
    expect(anchorAt(stage)).toBeNull();
    stage.remove();
  });
});

describe('putting a place back on a page still drawing', () => {
  /** A stage whose content grows, the most it can be scrolled being `max`. */
  function growing(max: number) {
    let room = max;
    let top = 0;
    const node = document.createElement('div');
    Object.defineProperty(node, 'scrollTop', { get: () => top, set: (value: number) => { top = Math.max(0, Math.min(value, room)); } });
    box(node, 0, 800);
    return { node, grow: (by: number) => { room += by; } };
  }
  let frames: FrameRequestCallback[] = [];
  let clock = 0;
  beforeEach(() => {
    frames = [];
    clock = 0;
    jest.spyOn(performance, 'now').mockImplementation(() => clock);
    jest.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { frames.push(callback); return frames.length; });
    jest.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => { frames = []; });
  });
  afterEach(() => { jest.restoreAllMocks(); });
  /** One frame, `ms` after the last. */
  const tick = (ms = 16) => { clock += ms; const now = frames; frames = []; for (const callback of now) callback(clock); };

  test('follows the page as it grows until the place is reached, with scroll anchoring off until it settles', () => {
    const { node, grow } = growing(400);
    placeStage(node, at(1000));
    expect(node.scrollTop).toBe(400);
    expect(node.style.overflowAnchor).toBe('none');
    grow(300);
    tick();
    expect(node.scrollTop).toBe(700);
    grow(500);
    tick();
    expect(node.scrollTop).toBe(1000);
    // Held, then let go once the page has had its two seconds to settle.
    tick(1_000);
    expect(frames).toHaveLength(1);
    tick(1_100);
    expect(frames).toHaveLength(0);
    expect(node.style.overflowAnchor).toBe('');
  });

  test('the row that was at the top comes back to the same height, though the rows above it are drawn taller now', () => {
    const { node } = growing(10_000);
    const row = document.createElement('article');
    row.dataset.run = '190';
    node.append(row);
    // Drawn again, the rows above the run are taller than when it was left: it sits 4,286 pixels down the page.
    row.getBoundingClientRect = () => ({ top: 4286 - node.scrollTop } as DOMRect);
    placeStage(node, { top: 3558, anchor: { selector: '[data-run="190"]', offset: 319 } });
    // 4286 − scrollTop = 319, so the stage is 3967 down: the run is where it was left.
    expect(node.scrollTop).toBe(3967);
    // A row above it drawn at its real height moves the run up 40; the place follows it.
    row.getBoundingClientRect = () => ({ top: 4246 - node.scrollTop } as DOMRect);
    tick();
    expect(node.scrollTop).toBe(3927);
  });

  test('gives up when the person scrolls, or when the page moves the stage itself', () => {
    const scrolled = growing(400);
    placeStage(scrolled.node, at(1000));
    scrolled.node.dispatchEvent(new Event('wheel'));
    scrolled.grow(1000);
    tick();
    expect(scrolled.node.scrollTop).toBe(400);
    expect(scrolled.node.style.overflowAnchor).toBe('');

    const moved = growing(400);
    placeStage(moved.node, at(1000));
    moved.node.scrollTop = 120;
    moved.grow(1000);
    tick();
    expect(moved.node.scrollTop).toBe(120);
  });

  test('the top needs nothing held', () => {
    const { node } = growing(400);
    node.scrollTop = 300;
    placeStage(node, at(0));
    expect(node.scrollTop).toBe(0);
    expect(frames).toHaveLength(0);
    expect(node.style.overflowAnchor).toBe('');
  });
});

describe('in the frame', () => {
  let go: NavigateFunction | null = null;
  function Navigator() {
    go = useNavigate();
    return null;
  }
  /** A screen that opens at its own place, as Settings' `?focus=` does, in an ordinary effect. */
  function Placed({ stage }: { stage: React.RefObject<HTMLElement | null> }) {
    useEffect(() => { if (stage.current) stage.current.scrollTop = 777; }, [stage]);
    return <p>placed</p>;
  }
  function Frame() {
    const stage = useRef<HTMLElement>(null);
    return (
      <main ref={stage} data-testid="stage">
        <StageScroll stage={stage} />
        <Navigator />
        <Routes>
          <Route path="/placed" element={<Placed stage={stage} />} />
          <Route path="*" element={<p>a screen</p>} />
        </Routes>
      </main>
    );
  }
  /** The person scrolls the stage: it moves, and says so. */
  const scrollTo = (stage: HTMLElement, top: number) => {
    stage.scrollTop = top;
    stage.dispatchEvent(new Event('scroll'));
  };
  beforeAll(() => { document.elementFromPoint = () => null; });
  afterAll(() => { delete (document as { elementFromPoint?: unknown }).elementFromPoint; });

  test('a new screen at its top, Back where it was left, Forward where that one was, and a screen\'s own place kept', () => {
    const view = render(<MemoryRouter initialEntries={['/runs']}><Frame /></MemoryRouter>);
    const stage = view.getByTestId('stage');
    scrollTo(stage, 2400);
    act(() => { void go!('/health/analytics'); });
    expect(stage.scrollTop).toBe(0);
    scrollTo(stage, 150);
    act(() => { void go!(-1); });
    expect(stage.scrollTop).toBe(2400);
    act(() => { void go!(1); });
    expect(stage.scrollTop).toBe(150);
    // A filter on the same screen leaves the place alone.
    act(() => { void go!('/health/analytics?source=arxiv'); });
    expect(stage.scrollTop).toBe(150);
    // A screen that puts the stage somewhere when it opens does so after the frame, and keeps it.
    act(() => { void go!('/placed'); });
    expect(stage.scrollTop).toBe(777);
    view.unmount();
  });
});
