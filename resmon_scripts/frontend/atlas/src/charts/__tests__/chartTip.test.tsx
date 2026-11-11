/**
 * The charts' one tooltip: where it goes (beside its mark, never over it, and
 * inside the window), what it says (the number first, the parts, what a click
 * does, and nothing about a click that does nothing), and how the keyboard
 * reaches a chart's marks (one stop, the arrow keys between marks).
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ChartTip, tipWords, useChartTip, type TipContent } from '../ChartTip';
import { exactCount, exactDays, exactShare } from '../exact';
import { EDGE, GAP, overlaps, placeTip, type Box } from '../place';
import { joined, useGridRoving, useRoving } from '../roving';

// jsdom has no PointerEvent; without one a pointer event carries no position.
if (!('PointerEvent' in window)) {
  class PointerEventShim extends MouseEvent {}
  Object.defineProperty(window, 'PointerEvent', { value: PointerEventShim, configurable: true });
}

const VIEW = { width: 1000, height: 700 };
const SIZE = { width: 220, height: 90 };
const boxAt = (left: number, top: number, width: number, height: number): Box =>
  ({ left, top, right: left + width, bottom: top + height });
const placedBox = (at: { left: number; top: number }) => boxAt(at.left, at.top, SIZE.width, SIZE.height);
const inside = (b: Box) => b.left >= EDGE && b.top >= EDGE && b.right <= VIEW.width - EDGE && b.bottom <= VIEW.height - EDGE;

describe('where the tip goes', () => {
  test('above its mark where there is room, centered on it, the gap between them', () => {
    const mark = boxAt(400, 300, 100, 10);
    const at = placeTip(mark, SIZE, VIEW);
    expect(at.side).toBe('above');
    expect(at.top).toBe(300 - GAP - SIZE.height);
    expect(at.left).toBe(450 - SIZE.width / 2);
  });

  test('along a long bar it follows the pointer, and stays on the bar\'s side', () => {
    const bar = boxAt(100, 300, 600, 10);
    expect(placeTip(bar, SIZE, VIEW, { x: 200, y: 305 }).left).toBe(200 - SIZE.width / 2);
    expect(placeTip(bar, SIZE, VIEW, { x: 600, y: 305 }).left).toBe(600 - SIZE.width / 2);
    // A pointer reported just past the mark's edge is read at the edge.
    expect(placeTip(bar, SIZE, VIEW, { x: 900, y: 305 }).left).toBe(700 - SIZE.width / 2);
  });

  test('below a mark at the window\'s top, and slid inside the window at its sides', () => {
    const top = placeTip(boxAt(4, 20, 30, 30), SIZE, VIEW);
    expect(top.side).toBe('below');
    expect(top.left).toBe(EDGE);
    const right = placeTip(boxAt(980, 20, 16, 16), SIZE, VIEW);
    expect(right.left + SIZE.width).toBe(VIEW.width - EDGE);
  });

  test('beside a mark as tall as the window', () => {
    expect(placeTip(boxAt(100, 0, 40, 700), SIZE, VIEW).side).toBe('right');
    expect(placeTip(boxAt(900, 0, 90, 700), SIZE, VIEW).side).toBe('left');
  });

  test('never under macOS\'s tab bar, which covers the window\'s top while the windows are in tabs', () => {
    const strip = 28;
    // Room above the mark, but only under the tab bar: the tip goes below instead.
    const below = placeTip(boxAt(400, 120, 100, 10), SIZE, VIEW, null, strip);
    expect(below.side).toBe('below');
    expect(placeTip(boxAt(400, 120, 100, 10), SIZE, VIEW).side).toBe('above');
    // Beside a tall mark, slid down clear of it.
    const beside = placeTip(boxAt(100, 0, 40, 700), SIZE, VIEW, { x: 120, y: 5 }, strip);
    expect(beside.side).toBe('right');
    expect(beside.top).toBe(strip + EDGE);
  });

  test('never over its mark and always inside the window, wherever the mark is', () => {
    let seed = 7;
    const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let n = 0; n < 2000; n++) {
      const w = 2 + random() * 300, h = 2 + random() * 200;
      const mark = boxAt(random() * (VIEW.width - w), random() * (VIEW.height - h), w, h);
      const pointer = random() < 0.5 ? { x: mark.left + random() * w, y: mark.top + random() * h } : null;
      const at = placeTip(mark, SIZE, VIEW, pointer);
      const tip = placedBox(at);
      expect(inside(tip)).toBe(true);
      if (at.side !== 'corner') expect(overlaps(tip, mark)).toBe(false);
    }
  });
});

describe('the numbers, as the engine served them', () => {
  test('a share to every place it was served to, and nothing for not enough', () => {
    expect(exactShare(0.7834)).toBe('78.34%');
    expect(exactShare(0.8)).toBe('80%');
    expect(exactShare(1)).toBe('100%');
    expect(exactShare(0)).toBe('0%');
    expect(exactShare(0.0005)).toBe('0.05%');
    expect(exactShare(0.125)).toBe('12.5%');
    expect(exactShare(null)).toBeNull();
  });

  test('days to the place the engine rounded to, and a paper seen before its date said so', () => {
    expect(exactDays(0.4)).toBe('0.4 days');
    expect(exactDays(1)).toBe('1 day');
    expect(exactDays(12.5)).toBe('12.5 days');
    expect(exactDays(-2.3)).toBe('2.3 days before its stated date');
    expect(exactDays(null)).toBeNull();
  });

  test('a count whole, with its thousands marked', () => {
    expect(exactCount(12408)).toBe('12,408');
  });
});

const SOURCE: TipContent = {
  name: 'arXiv',
  value: '150 papers',
  lines: [
    { value: '120', label: 'only from this source', key: 'accent' },
    { value: '30', label: 'also from another source', key: 'context' },
  ],
  notes: ['80% of its papers came from no other source.'],
  opens: 'Opens Search › Collection narrowed to arXiv',
};

test('the tip as one sentence, for a mark\'s accessible name', () => {
  expect(tipWords(SOURCE)).toBe('arXiv: 150 papers, 120 only from this source and 30 also from another source. '
    + '80% of its papers came from no other source. Opens Search › Collection narrowed to arXiv.');
  expect(tipWords({ value: 'B3' })).toBe('B3.');
});

/** jsdom draws nothing, so every element is given a box: a mark's from its `data-box`, the tip's its size. */
function boxes() {
  return jest.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const box = (this as HTMLElement).dataset?.box;
    if (box) {
      const [left, top, width, height] = box.split(' ').map(Number) as [number, number, number, number];
      return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) };
    }
    if (this.classList.contains('chart-tip')) {
      return { left: 0, top: 0, width: 220, height: 90, right: 220, bottom: 90, x: 0, y: 0, toJSON: () => ({}) };
    }
    return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) };
  });
}

/** A chart of three marks: the first opens something, the second and third do not. */
function Chart() {
  const tip = useChartTip();
  const roving = useRoving(3);
  const marks: TipContent[] = [SOURCE, { name: 'Everything else', value: '12 papers' }, { name: 'May 2026', value: '0 papers' }];
  return (
    <div role="group" aria-label="Chart">
      {marks.map((content, i) => (
        <a key={content.name} href={`#/m${i}`} data-box={`${100 + i * 200} 400 100 12`} aria-label={tipWords(content)}
          {...joined(roving.item(i), tip.mark(content))}>{content.name}</a>
      ))}
      {tip.layer}
    </div>
  );
}

describe('a chart\'s tip on the page', () => {
  let spy: jest.SpyInstance;
  beforeEach(() => {
    spy = boxes();
    Object.defineProperty(window, 'innerWidth', { value: 1000, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 700, configurable: true });
  });
  afterEach(() => spy.mockRestore());

  test('the pointer over a mark shows its tip, the number first, set above the mark and inside the window', () => {
    render(<Chart />);
    const mark = screen.getByRole('link', { name: /^arXiv/ });
    fireEvent.pointerEnter(mark, { clientX: 160, clientY: 405 });
    const tip = screen.getByRole('tooltip');
    expect(tip.parentElement).toBe(document.body);
    expect(tip.querySelector('.chart-tip-name')?.textContent).toBe('arXiv');
    expect(tip.querySelector('.chart-tip-value')?.textContent).toBe('150 papers');
    expect([...tip.querySelectorAll('.chart-tip-lines li')].map((li) => li.textContent)).toEqual(['120 only from this source', '30 also from another source']);
    expect([...tip.querySelectorAll('.chart-tip-key')].map((k) => k.getAttribute('data-key'))).toEqual(['accent', 'context']);
    expect(tip.querySelector('.chart-tip-opens')?.textContent).toBe('Opens Search › Collection narrowed to arXiv');
    expect(tip.dataset.side).toBe('above');
    expect(tip.style.top).toBe(`${400 - GAP - 90}px`);
    expect(tip.style.left).toBe(`${160 - 110}px`);
    // It follows the pointer along the mark.
    fireEvent.pointerMove(mark, { clientX: 190, clientY: 405 });
    expect(screen.getByRole('tooltip').style.left).toBe(`${190 - 110}px`);
    fireEvent.pointerLeave(mark);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  test('in a window whose windows are in macOS tabs, the tip keeps out from under the tab bar', () => {
    document.documentElement.style.setProperty('--tab-strip', '300px');
    try {
      render(<Chart />);
      // Room above the mark (at 400) for the tip, but under the tab bar's 300 pixels: it goes below.
      fireEvent.pointerEnter(screen.getByRole('link', { name: /^arXiv/ }), { clientX: 160, clientY: 405 });
      expect(screen.getByRole('tooltip').dataset.side).toBe('below');
      expect(screen.getByRole('tooltip').style.top).toBe(`${412 + GAP}px`);
    } finally {
      document.documentElement.style.removeProperty('--tab-strip');
    }
  });

  test('a mark that opens nothing has a tip that offers nothing', () => {
    render(<Chart />);
    fireEvent.pointerEnter(screen.getByRole('link', { name: /^Everything else/ }), { clientX: 350, clientY: 405 });
    expect(screen.getByRole('tooltip').querySelector('.chart-tip-opens')).toBeNull();
    expect(screen.getByRole('tooltip').textContent).not.toMatch(/Opens/);
  });

  test('the keyboard reaches the marks as one stop, the arrow keys move between them, and the tip follows the focus', () => {
    render(<Chart />);
    const [first, second, third] = screen.getAllByRole('link');
    expect([first, second, third].map((m) => m?.tabIndex)).toEqual([0, -1, -1]);
    act(() => first?.focus());
    expect(screen.getByRole('tooltip').querySelector('.chart-tip-value')?.textContent).toBe('150 papers');
    fireEvent.keyDown(first!, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(second);
    expect([first, second, third].map((m) => m?.tabIndex)).toEqual([-1, 0, -1]);
    expect(screen.getByRole('tooltip').querySelector('.chart-tip-name')?.textContent).toBe('Everything else');
    // Set beside the focused mark, centered on it, with no pointer to follow.
    expect(screen.getByRole('tooltip').style.left).toBe(`${300 + 50 - 110}px`);
    fireEvent.keyDown(second!, { key: 'End' });
    expect(document.activeElement).toBe(third);
    fireEvent.keyDown(third!, { key: 'Home' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first!, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(first);
    // Escape puts the tip away; the mark keeps the keyboard.
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(document.activeElement).toBe(first);
    // Moving on shows the next mark's tip, and leaving the chart puts it away.
    fireEvent.keyDown(first!, { key: 'ArrowDown' });
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    act(() => second?.blur());
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  test('a mark\'s accessible name says everything its tip says', () => {
    render(<Chart />);
    expect(screen.getByRole('link', { name: tipWords(SOURCE) })).toBeInTheDocument();
  });

  test('the pointer leaving does not put away the keyboard\'s tip', () => {
    render(<Chart />);
    const [first] = screen.getAllByRole('link');
    act(() => first?.focus());
    fireEvent.pointerLeave(first!);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
  });

  test('a scroll puts away a tip the pointer brought once its mark is no longer under the pointer, and keeps it while it is', () => {
    render(<Chart />);
    const mark = screen.getByRole('link', { name: /^arXiv/ });
    const under = jest.fn<Element | null, [number, number]>(() => mark);
    Object.defineProperty(document, 'elementFromPoint', { value: under, configurable: true });
    fireEvent.pointerEnter(mark, { clientX: 160, clientY: 405 });
    fireEvent.scroll(window);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    under.mockReturnValue(document.body);
    fireEvent.scroll(window);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  test('a pointer entering another chart replaces the focused chart tip without moving keyboard focus', () => {
    function TwoCharts() {
      const volume = useChartTip();
      const calendar = useChartTip();
      return (
        <>
          <a href="#/search?from=2024-03-01" data-box="100 400 100 12"
            {...volume.mark({ name: 'March 2024', value: '15 papers' })}>Publication month</a>
          <button type="button" data-box="300 400 100 12"
            {...calendar.mark({ name: 'Protein structure · November', value: '2 runs' })}>Calendar month</button>
          {volume.layer}{calendar.layer}
        </>
      );
    }
    render(<TwoCharts />);
    const focused = screen.getByRole('link', { name: 'Publication month' });
    const hovered = screen.getByRole('button', { name: 'Calendar month' });
    act(() => focused.focus());
    expect(screen.getByRole('tooltip')).toHaveTextContent('March 2024');
    fireEvent.pointerEnter(hovered, { clientX: 350, clientY: 405 });
    expect(screen.getAllByRole('tooltip')).toHaveLength(1);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Protein structure · November');
    expect(focused).toHaveFocus();
    // Events from the older chart cannot dismiss the newer chart's tip.
    fireEvent.pointerLeave(focused);
    act(() => focused.blur());
    expect(screen.getByRole('tooltip')).toHaveTextContent('Protein structure · November');
    fireEvent.pointerLeave(hovered);
    expect(screen.queryByRole('tooltip')).toBeNull();
    act(() => focused.focus());
    expect(screen.getByRole('tooltip')).toHaveTextContent('March 2024');
  });

  test('a tip given an element to stand beside draws nothing without content', () => {
    const element = document.createElement('span');
    const { rerender } = render(<ChartTip anchor={{ element }} content={null} />);
    expect(screen.queryByRole('tooltip')).toBeNull();
    rerender(<ChartTip anchor={{ element }} content={{ value: 'B3' }} />);
    expect(screen.getByRole('tooltip').textContent).toBe('B3');
  });
});

function Grid() {
  const roving = useGridRoving(3, 4, { row: 0, column: 3 });
  return (
    <table><tbody>
      {[0, 1, 2].map((row) => (
        <tr key={row}>{[0, 1, 2, 3].map((column) => (
          <td key={column}><button type="button" {...roving.cell(row, column)}>{`${row}:${column}`}</button></td>
        ))}</tr>
      ))}
    </tbody></table>
  );
}

test('a grid of marks is one stop: the arrow keys move a cell at a time, Home and End along the row and, held, to the corners', () => {
  render(<Grid />);
  const cell = (r: number, c: number) => screen.getByRole('button', { name: `${r}:${c}` });
  expect(screen.getAllByRole('button').filter((b) => b.tabIndex === 0)).toEqual([cell(0, 3)]);
  act(() => cell(0, 3).focus());
  fireEvent.keyDown(cell(0, 3), { key: 'ArrowDown' });
  expect(document.activeElement).toBe(cell(1, 3));
  fireEvent.keyDown(cell(1, 3), { key: 'ArrowLeft' });
  expect(document.activeElement).toBe(cell(1, 2));
  fireEvent.keyDown(cell(1, 2), { key: 'Home' });
  expect(document.activeElement).toBe(cell(1, 0));
  fireEvent.keyDown(cell(1, 0), { key: 'End', ctrlKey: true });
  expect(document.activeElement).toBe(cell(2, 3));
  fireEvent.keyDown(cell(2, 3), { key: 'ArrowDown' });
  expect(document.activeElement).toBe(cell(2, 3));
  expect(screen.getAllByRole('button').filter((b) => b.tabIndex === 0)).toEqual([cell(2, 3)]);
});

test('two sets of handlers on one mark both run', () => {
  const calls: string[] = [];
  const both = joined({ onFocus: () => calls.push('roving'), tabIndex: 0 }, { onFocus: () => calls.push('tip'), onBlur: () => calls.push('blur') });
  both.onFocus();
  both.onBlur();
  expect(calls).toEqual(['roving', 'tip', 'blur']);
  expect(both.tabIndex).toBe(0);
});


test.each([
  [[], 'Months.'],
  [[{value: 'January', label: ''}], 'Months, January.'],
  [[{value: 'January', label: ''}, {value: 'February', label: ''}], 'Months, January and February.'],
  [[{value: 'January', label: ''}, {value: 'February', label: ''}, {value: 'March', label: ''}], 'Months, January, February, and March.'],
])('accessible chart lists join their parts without treating the headline as a list item (%j)', (lines, expected) => {
  expect(tipWords({ value: 'Months', lines })).toBe(expected);
});
