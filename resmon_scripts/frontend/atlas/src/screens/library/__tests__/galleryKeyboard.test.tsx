import { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { Gallery } from '../Gallery';

let mockDrawn = [0, 1, 2];
const scrollToIndex = jest.fn();
const measure = jest.fn();
const measureElement = jest.fn();
jest.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: () => ({
    getTotalSize: () => 1200,
    getVirtualItems: () => mockDrawn.map((index) => ({ index, key: index, start: index * 400 })),
    scrollToIndex, measure, measureElement,
  }),
}));
class Resizes { observe() {} disconnect() {} }
beforeEach(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = Resizes;
  jest.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(960);
  scrollToIndex.mockReset();
  mockDrawn = [0, 1, 2];
});
afterEach(() => { jest.restoreAllMocks(); delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver; });

function gallery() {
  const onSelectAll = jest.fn();
  const props = {
    items: Array.from({ length: 8 }, (_, i) => `file-${i}`), keyOf: (id: string) => id,
    label: 'Your Files', total: 8, more: { has: false, reading: false, failed: false, read: jest.fn() }, onSelectAll,
  };
  render(<main className="stage"><Gallery {...props}>{(id) => <a href={`#/${id}`} className="thumb">{id}</a>}</Gallery></main>);
  return { onSelectAll, cards: screen.getAllByRole('link') };
}

test('Left and Right focus neighboring cards; Up and Down keep the column across rows', () => {
  const { cards } = gallery();
  act(() => cards[0]!.focus());
  fireEvent.keyDown(cards[0]!, { key: 'ArrowRight' });
  expect(cards[1]).toHaveFocus();
  fireEvent.keyDown(cards[1]!, { key: 'ArrowDown' });
  expect(cards[5]).toHaveFocus();
  fireEvent.keyDown(cards[5]!, { key: 'ArrowLeft' });
  expect(cards[4]).toHaveFocus();
  fireEvent.keyDown(cards[4]!, { key: 'ArrowUp' });
  expect(cards[0]).toHaveFocus();
  fireEvent.keyDown(cards[0]!, { key: 'ArrowLeft' });
  expect(cards[0]).toHaveFocus();
});

test.each(['metaKey', 'ctrlKey'])('%s+A selects the shelf and prevents browser text selection', (modifier) => {
  const { cards, onSelectAll } = gallery();
  const event = new KeyboardEvent('keydown', { key: 'a', [modifier]: true, bubbles: true, cancelable: true });
  fireEvent(cards[0]!, event);
  expect(event.defaultPrevented).toBe(true);
  expect(onSelectAll).toHaveBeenCalledTimes(1);
});


test('an arrow can reach a row that is outside the virtual window', () => {
  mockDrawn = [0];
  scrollToIndex.mockImplementationOnce((row: number) => { mockDrawn = [row]; });
  const { cards } = gallery();
  cards[1]!.focus();
  fireEvent.keyDown(cards[1]!, { key: 'ArrowDown' });
  expect(screen.getByRole('link', { name: 'file-5' })).toHaveFocus();
  expect(scrollToIndex).toHaveBeenCalledWith(1, { align: 'auto' });
});

test('Select All keeps focus on the same card when its cover changes from a link to a pick button', () => {
  function Selectable() {
    const [selected, setSelected] = useState(false);
    return (
      <main className="stage"><Gallery items={['a', 'b']} keyOf={(id) => id} label="Saved papers" total={2}
        more={{ has: false, reading: false, failed: false, read: () => undefined }} onSelectAll={() => setSelected(true)}>
        {(id) => selected ? <button className="thumb" aria-pressed="true">{id}</button> : <a href={`#/${id}`} className="thumb">{id}</a>}
      </Gallery></main>
    );
  }
  render(<Selectable />);
  const opener = screen.getByRole('link', { name: 'b' });
  opener.focus();
  fireEvent.keyDown(opener, { key: 'a', metaKey: true });
  expect(screen.getByRole('button', { name: 'b' })).toHaveFocus();
});


test('vertical arrows use all six drawn grid tracks', () => {
  jest.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1500);
  const props = { items: Array.from({ length: 18 }, (_, i) => `paper-${i}`), keyOf: (id: string) => id,
    label: 'Your Files', total: 18, more: { has: false, reading: false, failed: false, read: jest.fn() } };
  render(<main className="stage"><Gallery {...props}>{(id) => <a href={`#/${id}`} className="thumb">{id}</a>}</Gallery></main>);
  const cards = screen.getAllByRole('link');
  expect(screen.getByRole('list')).toHaveAttribute('data-columns', '6');
  act(() => cards[1]!.focus());
  fireEvent.keyDown(cards[1]!, { key: 'ArrowDown' });
  expect(cards[7]).toHaveFocus();
  fireEvent.keyDown(cards[7]!, { key: 'ArrowUp' });
  expect(cards[1]).toHaveFocus();
});


test('a deferred arrow target never overrides the card the keyboard is actually on', () => {
  mockDrawn = [0];
  const { cards } = gallery();
  act(() => cards[1]!.focus());
  // The next row has not been drawn yet, so its target waits.
  fireEvent.keyDown(cards[1]!, { key: 'ArrowDown' });
  act(() => cards[2]!.focus());
  scrollToIndex.mockImplementationOnce((row: number) => { mockDrawn = [row]; });
  fireEvent.keyDown(cards[2]!, { key: 'ArrowDown' });
  expect(screen.getByRole('link', { name: 'file-6' })).toHaveFocus();
});
