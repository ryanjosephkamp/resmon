/**
 * The stage's place on each history entry: a new screen opens at its top,
 * Back and Forward put a screen back where it was left (by the row that was at
 * its top, where there is one), a change of address within one screen leaves
 * it where it is, and a screen that opens at its own place keeps it.
 */
import { useEffect, useRef, useState } from 'react';
import { act, render } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate, useParams, type NavigateFunction } from 'react-router-dom';
import {
  HOLD_MS, SCROLL_LIMIT, SETTLE_MS, ScrollMemory, ScrollPlaces, StageScroll, anchorAt, holdsPlace, landing, placeStage, useScrollerPlace, type Place,
} from '../stageScroll';

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
function box(node: Element, top: number, height = 70, left = 0, width = 600) {
  node.getBoundingClientRect = () => ({ top, bottom: top + height, left, right: left + width, width, height, x: left, y: top, toJSON: () => ({}) });
}

describe('the row at the top', () => {
  afterEach(() => { delete (document as { elementFromPoint?: unknown }).elementFromPoint; });
  /** A stage 800 high whose top edge is 52 down the window, holding `html`. */
  function stageOf(html: string) {
    const stage = document.createElement('main');
    stage.innerHTML = html;
    document.body.append(stage);
    box(stage, 52, 800);
    return stage;
  }

  test('is the first row whose top is in view, known by what it is and found once, past a mark that shows up in every row', () => {
    const stage = stageOf(`
      <div class="bar">filters</div>
      <article data-run="190"><span data-source="arxiv">arXiv</span> run 0190</article>
      <article data-run="189"><span data-source="arxiv">arXiv</span> run 0189</article>`);
    const [bar, cut, below] = [stage.querySelector('.bar')!, stage.querySelector('[data-run="190"]')!, stage.querySelector('[data-run="189"]')!];
    // The run cut by the top edge, 22 above it, and the one below it, whose top is 48 down.
    box(cut, 30);
    box(below, 100);
    document.elementFromPoint = (_x: number, y: number) => (y < 100 ? cut.querySelector('span') : below.querySelector('span'));
    expect(anchorAt(stage)).toEqual({ selector: '[data-run="189"]', offset: 48 });
    // A bar held at the top covers the first heights; the source mark below it is in every run, so the run is the row.
    document.elementFromPoint = (_x: number, y: number) => (y < 140 ? bar : below.querySelector('span'));
    box(below, 140);
    expect(anchorAt(stage)).toEqual({ selector: '[data-run="189"]', offset: 88 });
    document.elementFromPoint = () => bar;
    expect(anchorAt(stage)).toBeNull();
    stage.remove();
  });

  test('is found across the stage, where two fifths across falls in the gap between two covers', () => {
    const stage = stageOf('<div class="gal-row"><article data-document="7">a cover</article><article data-document="8">another</article></div>');
    const [gap, card] = [stage.querySelector('.gal-row')!, stage.querySelector('[data-document="7"]')!];
    box(card, 60, 400, 0, 220);
    document.elementFromPoint = (x: number) => (x < 200 ? card : gap);
    expect(anchorAt(stage)).toEqual({ selector: '[data-document="7"]', offset: 8 });
    stage.remove();
  });

  test('looks past a page known by what it is and taller than the view, for a row on it', () => {
    const stage = stageOf('<div data-run="12"><h2>Papers</h2><ol><li data-document="40">a paper</li></ol></div>');
    const [page, heading, paper] = [stage.querySelector('[data-run="12"]')!, stage.querySelector('h2')!, stage.querySelector('[data-document="40"]')!];
    box(page, -600, 3000);
    box(paper, 130);
    document.elementFromPoint = (_x: number, y: number) => (y < 120 ? heading : paper);
    expect(anchorAt(stage)).toEqual({ selector: '[data-document="40"]', offset: 78 });
    stage.remove();
  });

  test('is not a row in a box that scrolls on its own, as Search › Your collection\'s results do', () => {
    const stage = stageOf('<div class="index-scroll" style="overflow-y: auto"><ol><li data-document="40">a paper</li></ol></div>');
    const [scroller, paper] = [stage.querySelector<HTMLElement>('.index-scroll')!, stage.querySelector('[data-document="40"]')!];
    let tall = 5000;
    Object.defineProperty(scroller, 'scrollHeight', { get: () => tall });
    Object.defineProperty(scroller, 'clientHeight', { get: () => 700 });
    box(paper, 130);
    document.elementFromPoint = () => paper;
    expect(anchorAt(stage)).toBeNull();
    // The same box with nothing to scroll moves with the stage, and its row is the stage's.
    tall = 700;
    expect(anchorAt(stage)).toEqual({ selector: '[data-document="40"]', offset: 78 });
    stage.remove();
  });
});

describe('putting a place back on a page still drawing', () => {
  /**
   * A stage 800 high whose content grows and shrinks, the most it can be
   * scrolled being `max`; as in a browser, a page grown shorter pushes the
   * stage back to its end.
   */
  function growing(max: number) {
    let room = max;
    let top = 0;
    const node = document.createElement('div');
    Object.defineProperty(node, 'scrollTop', { get: () => top, set: (value: number) => { top = Math.max(0, Math.min(value, room)); } });
    Object.defineProperty(node, 'scrollHeight', { get: () => room + 800 });
    Object.defineProperty(node, 'clientHeight', { get: () => 800 });
    box(node, 0, 800);
    document.body.append(node);
    return { node, grow: (by: number) => { room += by; top = Math.min(top, room); } };
  }
  /** A row `down` pixels down the stage's content, which can be moved. */
  function rowIn(node: HTMLElement, id: string, down: number) {
    const row = document.createElement('article');
    row.dataset.run = id;
    let at = down;
    row.getBoundingClientRect = () => ({ top: at - node.scrollTop } as DOMRect);
    node.append(row);
    return { row, move: (to: number) => { at = to; } };
  }
  /** A `ResizeObserver` the test says when to fire. */
  class Resizes {
    static made: Resizes[] = [];
    off = false;
    constructor(private readonly callback: () => void) { Resizes.made.push(this); }
    observe() { /* everything */ }
    unobserve() { /* nothing */ }
    disconnect() { this.off = true; }
    static fire() { for (const one of Resizes.made) if (!one.off) one.callback(); }
  }
  let frames: FrameRequestCallback[] = [];
  let clock = 0;
  beforeEach(() => {
    frames = [];
    clock = 0;
    Resizes.made = [];
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = Resizes;
    jest.spyOn(performance, 'now').mockImplementation(() => clock);
    jest.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { frames.push(callback); return frames.length; });
    jest.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => { frames = []; });
  });
  afterEach(() => {
    jest.restoreAllMocks();
    delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    document.body.innerHTML = '';
  });
  /** One frame, `ms` after the last. */
  const tick = (ms = 16) => { clock += ms; const now = frames; frames = []; for (const callback of now) callback(clock); };
  const held = (node: HTMLElement) => frames.length > 0 && holdsPlace(node) && node.style.overflowAnchor === 'none';
  const run = { selector: '[data-run="190"]', offset: 319 };

  test('follows the page as it grows until the place is reached, with scroll anchoring off and the stage held meanwhile', () => {
    const { node, grow } = growing(400);
    placeStage(node, at(1000));
    expect(node.scrollTop).toBe(400);
    expect(held(node)).toBe(true);
    grow(300);
    tick();
    expect(node.scrollTop).toBe(700);
    grow(500);
    tick();
    expect(node.scrollTop).toBe(1000);
  });

  test('the row that was at the top comes back to the same height, though the rows above it are drawn taller now', () => {
    const { node } = growing(10_000);
    // Drawn again, the rows above the run are taller than when it was left: it sits 4,286 pixels down the page.
    const { move } = rowIn(node, '190', 4286);
    placeStage(node, { top: 3558, anchor: run });
    // 4286 − scrollTop = 319, so the stage is 3967 down: the run is where it was left.
    expect(node.scrollTop).toBe(3967);
    // A row above it drawn at its real height moves the run up 40; the place follows it.
    move(4246);
    tick();
    expect(node.scrollTop).toBe(3927);
  });

  test('waits for a row the list has not drawn yet, at the old distance down, and puts the stage by it when it comes', () => {
    const { node } = growing(10_000);
    placeStage(node, { top: 3558, anchor: run });
    expect(node.scrollTop).toBe(3558);
    tick(400);
    tick(400);
    expect(node.scrollTop).toBe(3558);
    expect(held(node)).toBe(true);
    // The list draws it, and moves the stage as it does (as a virtualizer meeting its scroller can): it is put by the row.
    rowIn(node, '190', 4286);
    node.scrollTop = 3600;
    tick();
    expect(node.scrollTop).toBe(3967);
    expect(held(node)).toBe(true);
  });

  test('as the rows above it are measured, the row is put back in the same frame, before it is painted', () => {
    const { node } = growing(10_000);
    const { move } = rowIn(node, '190', 4286);
    placeStage(node, { top: 3558, anchor: run });
    expect(node.scrollTop).toBe(3967);
    // Rows above it measured shorter than their estimate, one after another, with no frame between.
    move(4200);
    Resizes.fire();
    expect(node.scrollTop).toBe(3881);
    move(4151);
    Resizes.fire();
    expect(node.scrollTop).toBe(3832);
    expect(held(node)).toBe(true);
  });

  test('a page grown shorter than the place pushes the stage to its end, and it is held there until the page is tall enough', () => {
    const { node, grow } = growing(10_000);
    const { move } = rowIn(node, '190', 4286);
    placeStage(node, { top: 3558, anchor: run });
    expect(node.scrollTop).toBe(3967);
    // The rows near the view drawn shorter than their estimate: the page ends above the place for now.
    grow(3_700 - 10_000);
    move(4100);
    tick();
    expect(node.scrollTop).toBe(3700);
    expect(held(node)).toBe(true);
    // The list's next page is read below: the run is put where it was left.
    grow(2_000);
    tick();
    expect(node.scrollTop).toBe(3781);
    expect(held(node)).toBe(true);
  });

  test('a list that moves the stage and keeps the row where it is held is not the page moving it', () => {
    const { node } = growing(10_000);
    const { move } = rowIn(node, '190', 4286);
    placeStage(node, { top: 3558, anchor: run });
    // A row above measured 30 taller, and the stage moved down 30 with it: the run stays where it was left.
    move(4316);
    node.scrollTop = 3997;
    tick();
    expect(node.scrollTop).toBe(3997);
    expect(held(node)).toBe(true);
  });

  test('gives up at once when the person moves the page: a wheel up or down, a touch, a key, or the pointer on the stage', () => {
    const moves: [string, () => Event][] = [
      ['wheel', () => new WheelEvent('wheel', { deltaY: 120 })],
      ['touchstart', () => new Event('touchstart')],
      ['pointerdown', () => new Event('pointerdown')],
    ];
    for (const [, event] of moves) {
      const { node, grow } = growing(400);
      placeStage(node, at(1000));
      node.dispatchEvent(event());
      grow(1000);
      tick();
      expect(node.scrollTop).toBe(400);
      expect(holdsPlace(node)).toBe(false);
      expect(node.style.overflowAnchor).toBe('');
    }
    const { node, grow } = growing(400);
    placeStage(node, at(1000));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    grow(1000);
    tick();
    expect(node.scrollTop).toBe(400);
    expect(holdsPlace(node)).toBe(false);
  });

  test('a wheel sideways, the rest of a swipe that went Back, does not let it go', () => {
    const { node, grow } = growing(400);
    placeStage(node, at(1000));
    node.dispatchEvent(new WheelEvent('wheel', { deltaX: -40, deltaY: 2 }));
    grow(1000);
    tick();
    expect(node.scrollTop).toBe(1000);
    expect(held(node)).toBe(true);
  });

  test('gives up when the page moves the stage itself, with the row or without one', () => {
    const moved = growing(400);
    placeStage(moved.node, at(1000));
    moved.node.scrollTop = 120;
    moved.grow(1000);
    tick();
    expect(moved.node.scrollTop).toBe(120);
    expect(holdsPlace(moved.node)).toBe(false);

    const placed = growing(10_000);
    rowIn(placed.node, '190', 4286);
    placeStage(placed.node, { top: 3558, anchor: run });
    // A screen that opens at its own place, as a file's #links does, after the row was put back.
    placed.node.scrollTop = 6000;
    tick();
    expect(placed.node.scrollTop).toBe(6000);
    expect(holdsPlace(placed.node)).toBe(false);
  });

  test('is held five seconds at most, and then the page is left to itself', () => {
    const { node } = growing(10_000);
    const { move } = rowIn(node, '190', 4286);
    placeStage(node, { top: 3558, anchor: run });
    for (let ms = 0; ms < HOLD_MS - 200; ms += 400) tick(400);
    move(4246);
    tick(100);
    expect(node.scrollTop).toBe(3927);
    expect(held(node)).toBe(true);
    tick(400);
    expect(holdsPlace(node)).toBe(false);
    expect(node.style.overflowAnchor).toBe('');
    move(4100);
    Resizes.fire();
    tick();
    expect(node.scrollTop).toBe(3927);
  });

  test('a row that never comes, deleted or filtered out since, leaves the old distance down, followed as the page grows', () => {
    const { node, grow } = growing(2_000);
    placeStage(node, { top: 3558, anchor: run });
    expect(node.scrollTop).toBe(2000);
    grow(3_000);
    tick();
    expect(node.scrollTop).toBe(3558);
    for (let ms = 0; ms <= HOLD_MS; ms += 500) tick(500);
    expect(holdsPlace(node)).toBe(false);
    expect(node.scrollTop).toBe(3558);
  });

  test('the top needs nothing held', () => {
    const { node } = growing(400);
    node.scrollTop = 300;
    placeStage(node, at(0));
    expect(node.scrollTop).toBe(0);
    expect(frames).toHaveLength(0);
    expect(holdsPlace(node)).toBe(false);
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

describe('the row at the top, read when the place is wanted', () => {
  let go: NavigateFunction | null = null;
  function Navigator() {
    go = useNavigate();
    return null;
  }
  function Frame() {
    const stage = useRef<HTMLElement>(null);
    return (
      <main ref={stage} data-testid="stage">
        <StageScroll stage={stage} />
        <Navigator />
        <Routes>
          <Route path="/runs" element={<article data-run="7">run 0007</article>} />
          <Route path="*" element={<p>a screen</p>} />
        </Routes>
      </main>
    );
  }
  /** How far down the stage's content the run is drawn; a list drawing its rows again at other heights moves it. */
  let down = 1000;
  /** Each time the row at the top is looked for. */
  let looks: jest.Mock;
  beforeEach(() => {
    jest.useFakeTimers();
    down = 1000;
    looks = jest.fn(() => document.querySelector('[data-run="7"]'));
    document.elementFromPoint = looks;
    // The run sits `down` pixels down the stage's content; the stage is 800 high, its top edge at the window's.
    jest.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function rect(this: Element) {
      const top = this.matches('[data-run]') ? down - (this.closest('main')?.scrollTop ?? 0) : 0;
      const height = this.matches('main') ? 800 : 70;
      return { top, bottom: top + height, left: 0, right: 600, width: 600, height, x: 0, y: top, toJSON: () => ({}) };
    });
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    delete (document as { elementFromPoint?: unknown }).elementFromPoint;
    delete (window as { navigation?: unknown }).navigation;
  });
  const scrollTo = (stage: HTMLElement, top: number) => {
    stage.scrollTop = top;
    stage.dispatchEvent(new Event('scroll'));
  };
  /** Away by a tab, the run drawn 400 pixels further down when the history is drawn again, and Back. */
  const awayAndBack = () => {
    act(() => { void go!('/health'); });
    down = 1400;
    act(() => { void go!(-1); });
  };

  test('once the stage has been still a moment, not on every scroll; Back then puts the run where it was', () => {
    const view = render(<MemoryRouter initialEntries={['/runs']}><Frame /></MemoryRouter>);
    const stage = view.getByTestId('stage');
    for (let top = 40; top <= 960; top += 40) scrollTo(stage, top);
    act(() => { jest.advanceTimersByTime(SETTLE_MS - 1); });
    expect(looks).not.toHaveBeenCalled();
    act(() => { jest.advanceTimersByTime(1); });
    expect(looks).toHaveBeenCalledTimes(1);
    awayAndBack();
    // By the run, 40 below the top edge as it was left, rather than 960 down.
    expect(stage.scrollTop).toBe(1360);
    view.unmount();
  });

  test('at once when the pointer goes down after a scroll, so a click that leaves the page keeps the row it left', () => {
    const view = render(<MemoryRouter initialEntries={['/runs']}><Frame /></MemoryRouter>);
    const stage = view.getByTestId('stage');
    scrollTo(stage, 960);
    stage.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(looks).toHaveBeenCalledTimes(1);
    // Read once: the pause after it has nothing left to read.
    act(() => { jest.advanceTimersByTime(SETTLE_MS); });
    expect(looks).toHaveBeenCalledTimes(1);
    awayAndBack();
    expect(stage.scrollTop).toBe(1360);
    view.unmount();
  });

  test('at once when a key goes down after a scroll, and not for a key with no scroll before it', () => {
    const view = render(<MemoryRouter initialEntries={['/runs']}><Frame /></MemoryRouter>);
    const stage = view.getByTestId('stage');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
    expect(looks).not.toHaveBeenCalled();
    scrollTo(stage, 960);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '[', metaKey: true }));
    expect(looks).toHaveBeenCalledTimes(1);
    awayAndBack();
    expect(stage.scrollTop).toBe(1360);
    view.unmount();
  });

  test('at once when the window is about to go to another page, as the Navigation API says before the router draws it', () => {
    const navigation = new EventTarget();
    (window as { navigation?: unknown }).navigation = navigation;
    const view = render(<MemoryRouter initialEntries={['/runs']}><Frame /></MemoryRouter>);
    const stage = view.getByTestId('stage');
    scrollTo(stage, 960);
    navigation.dispatchEvent(new Event('navigate'));
    expect(looks).toHaveBeenCalledTimes(1);
    awayAndBack();
    expect(stage.scrollTop).toBe(1360);
    view.unmount();
  });

  test('a page left before its row is read is put back by the distance down', () => {
    const view = render(<MemoryRouter initialEntries={['/runs']}><Frame /></MemoryRouter>);
    const stage = view.getByTestId('stage');
    scrollTo(stage, 960);
    awayAndBack();
    expect(stage.scrollTop).toBe(960);
    view.unmount();
  });

  test('nothing is read after the frame has gone', () => {
    const view = render(<MemoryRouter initialEntries={['/runs']}><Frame /></MemoryRouter>);
    scrollTo(view.getByTestId('stage'), 960);
    view.unmount();
    act(() => { jest.advanceTimersByTime(SETTLE_MS * 2); });
    window.dispatchEvent(new Event('pointerdown'));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '[' }));
    expect(looks).not.toHaveBeenCalled();
  });
});

describe('a box a screen scrolls on its own, as Search\'s results and a run\'s page do', () => {
  let go: NavigateFunction | null = null;
  function Navigator() {
    go = useNavigate();
    return null;
  }
  /** What else the list's place depends on, as Search's order does, which a Back finds as it was or not. */
  let order = 'newest';
  /** A screen whose list scrolls in its own box, the paper at `down` pixels down it; drawn once `drawn`. */
  function Results({ fresh = true, drawn = true }: { fresh?: boolean; drawn?: boolean }) {
    const box = useRef<HTMLDivElement>(null);
    const words = new URLSearchParams(useLocation().search).get('q') ?? '';
    useScrollerPlace(box, { name: 'results', under: `${words}/${order}`, fresh, drawn });
    if (!drawn) return <p>reading</p>;
    return <div ref={box} data-testid="box"><article data-document="7">a paper</article></div>;
  }
  function Frame({ fresh, drawn }: { fresh?: boolean; drawn?: boolean }) {
    const stage = useRef<HTMLElement>(null);
    return (
      <ScrollPlaces>
        <main ref={stage} data-testid="stage">
          <StageScroll stage={stage} />
          <Navigator />
          <Routes>
            <Route path="/search" element={<Results fresh={fresh} drawn={drawn} />} />
            <Route path="*" element={<p>a paper&rsquo;s page</p>} />
          </Routes>
        </main>
      </ScrollPlaces>
    );
  }
  /** How far down the box's content the paper is drawn; a list drawing its rows again at other heights moves it. */
  let down = 1000;
  let looks: jest.Mock;
  beforeEach(() => {
    jest.useFakeTimers();
    down = 1000;
    order = 'newest';
    looks = jest.fn(() => document.querySelector('[data-document="7"]'));
    document.elementFromPoint = looks;
    // The box is 800 high, its top edge at the window's; the paper sits `down` pixels down its content.
    jest.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function rect(this: Element) {
      const box = this.closest('[data-testid="box"]') as HTMLElement | null;
      const top = this.matches('[data-document]') ? down - (box?.scrollTop ?? 0) : 0;
      const height = this.matches('[data-testid="box"], main') ? 800 : 70;
      return { top, bottom: top + height, left: 0, right: 600, width: 600, height, x: 0, y: top, toJSON: () => ({}) };
    });
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    delete (document as { elementFromPoint?: unknown }).elementFromPoint;
  });
  const box = () => document.querySelector<HTMLElement>('[data-testid="box"]')!;
  /** The person scrolls the box, and the scroll comes to rest. */
  const scrollTo = (top: number) => {
    box().scrollTop = top;
    box().dispatchEvent(new Event('scroll'));
  };
  /** A paper opened from the list, its list drawn 400 pixels further down when Back draws it again, and Back. */
  const awayAndBack = () => {
    act(() => { void go!('/papers/7'); });
    expect(document.querySelector('[data-testid="box"]')).toBeNull();
    down = 1400;
    act(() => { void go!(-1); });
  };

  test('Back puts the list back by the paper at its top, read once the scroll has come to rest, and the stage stays put', () => {
    const view = render(<MemoryRouter initialEntries={['/search?q=tides']}><Frame /></MemoryRouter>);
    for (let top = 40; top <= 960; top += 40) scrollTo(top);
    // Nothing is looked for on the scroll itself.
    expect(looks).not.toHaveBeenCalled();
    act(() => { jest.advanceTimersByTime(SETTLE_MS); });
    expect(looks).toHaveBeenCalledTimes(1);
    awayAndBack();
    // By the paper, 40 below the top edge as it was left, rather than 960 down.
    expect(box().scrollTop).toBe(1360);
    expect(view.getByTestId('stage').scrollTop).toBe(0);
    view.unmount();
  });

  test('a click on a paper right after a scroll keeps the paper it left', () => {
    const view = render(<MemoryRouter initialEntries={['/search?q=tides']}><Frame /></MemoryRouter>);
    scrollTo(960);
    box().dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(looks).toHaveBeenCalledTimes(1);
    awayAndBack();
    expect(box().scrollTop).toBe(1360);
    view.unmount();
  });

  test('the hold waits for a paper the list has not drawn yet, at the old distance down, and puts the list by it when it comes', () => {
    const frames: FrameRequestCallback[] = [];
    jest.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { frames.push(callback); return frames.length; });
    const view = render(<MemoryRouter initialEntries={['/search?q=tides']}><Frame /></MemoryRouter>);
    scrollTo(960);
    act(() => { jest.advanceTimersByTime(SETTLE_MS); });
    act(() => { void go!('/papers/7'); });
    // Drawn again, the list has not drawn the paper yet.
    looks.mockReturnValue(null);
    const paper = jest.spyOn(Element.prototype, 'querySelector');
    paper.mockImplementation(function find(this: Element, selector: string) {
      return selector === '[data-document="7"]' && down > 5000 ? null : Element.prototype.querySelectorAll.call(this, selector)[0] ?? null;
    });
    down = 9999;
    act(() => { void go!(-1); });
    expect(box().scrollTop).toBe(960);
    expect(holdsPlace(box())).toBe(true);
    // The list draws it, 1,400 down: the box is put by it.
    down = 1400;
    act(() => { for (const frame of frames.splice(0)) frame(performance.now()); });
    expect(box().scrollTop).toBe(1360);
    view.unmount();
  });

  test('a Back to other results (another order now) opens them at their top', () => {
    const view = render(<MemoryRouter initialEntries={['/search?q=tides']}><Frame /></MemoryRouter>);
    scrollTo(960);
    act(() => { jest.advanceTimersByTime(SETTLE_MS); });
    act(() => { void go!('/papers/7'); });
    order = 'closest';
    act(() => { void go!(-1); });
    expect(box().scrollTop).toBe(0);
    view.unmount();
  });

  test('a new search on the screen opens the list at its top, and Back to the last one puts it where it was', () => {
    const view = render(<MemoryRouter initialEntries={['/search?q=tides']}><Frame /></MemoryRouter>);
    scrollTo(960);
    act(() => { jest.advanceTimersByTime(SETTLE_MS); });
    act(() => { void go!('/search?q=binaries'); });
    expect(box().scrollTop).toBe(0);
    down = 1400;
    act(() => { void go!(-1); });
    expect(box().scrollTop).toBe(1360);
    view.unmount();
  });

  test('without `fresh`, the same page shown another way (another of a run\'s tabs) is left where it is', () => {
    const view = render(<MemoryRouter initialEntries={['/search?q=tides']}><Frame fresh={false} /></MemoryRouter>);
    scrollTo(960);
    act(() => { void go!('/search?q=binaries', { replace: true }); });
    expect(box().scrollTop).toBe(960);
    view.unmount();
  });

  test('a run\'s tabs, each with a path, are one screen: another tab leaves the page where it is, and another run opens at its top', () => {
    function RunPage() {
      const box = useRef<HTMLDivElement>(null);
      const { id, tab = 'papers' } = useParams();
      useScrollerPlace(box, { name: 'run', under: tab, screen: `/runs/${id}` });
      return <div ref={box} data-testid="box"><article data-document="7">a paper</article></div>;
    }
    function RunFrame() {
      const stage = useRef<HTMLElement>(null);
      return (
        <ScrollPlaces>
          <main ref={stage} data-testid="stage">
            <StageScroll stage={stage} />
            <Navigator />
            <Routes><Route path="/runs/:id/:tab?" element={<RunPage />} /></Routes>
          </main>
        </ScrollPlaces>
      );
    }
    const view = render(<MemoryRouter initialEntries={['/runs/12/papers']}><RunFrame /></MemoryRouter>);
    scrollTo(960);
    act(() => { void go!('/runs/12/log'); });
    expect(box().scrollTop).toBe(960);
    // Back to the tab it was left on, where it was left.
    act(() => { jest.advanceTimersByTime(SETTLE_MS); });
    act(() => { void go!(-1); });
    expect(box().scrollTop).toBe(960);
    // Another run opens at its top.
    act(() => { void go!('/runs/13/papers'); });
    expect(box().scrollTop).toBe(0);
    view.unmount();
  });

  test('a box the screen draws after it opens, as a run\'s page once the run is read, is put back when it is drawn', () => {
    let drawn = true;
    let redraw: (n: number) => void = () => undefined;
    function Reading() {
      const [, set] = useState(0);
      redraw = set;
      return <Results drawn={drawn} />;
    }
    function Later() {
      const stage = useRef<HTMLElement>(null);
      return (
        <ScrollPlaces>
          <main ref={stage}>
            <StageScroll stage={stage} />
            <Navigator />
            <Routes>
              <Route path="/search" element={<Reading />} />
              <Route path="*" element={<p>a paper&rsquo;s page</p>} />
            </Routes>
          </main>
        </ScrollPlaces>
      );
    }
    const view = render(<MemoryRouter initialEntries={['/search?q=tides']}><Later /></MemoryRouter>);
    scrollTo(960);
    act(() => { jest.advanceTimersByTime(SETTLE_MS); });
    act(() => { void go!('/papers/7'); });
    drawn = false;
    act(() => { void go!(-1); });
    expect(document.querySelector('[data-testid="box"]')).toBeNull();
    down = 1400;
    act(() => { drawn = true; redraw(1); });
    expect(box().scrollTop).toBe(1360);
    view.unmount();
  });

  test('nothing is kept after the box has gone', () => {
    const view = render(<MemoryRouter initialEntries={['/search?q=tides']}><Frame /></MemoryRouter>);
    const gone = box();
    scrollTo(960);
    view.unmount();
    act(() => { jest.advanceTimersByTime(SETTLE_MS * 2); });
    gone.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new Event('pointerdown'));
    expect(looks).not.toHaveBeenCalled();
  });
});
