/**
 * A map's tip: the paper under the pointer (or the one the keyboard chose),
 * named as Today's list names it, set in the charts' one tooltip beside a box
 * at the paper, and saying what choosing it does on that map, or nothing
 * where it does nothing.
 */
import { render, screen } from '@testing-library/react';
import { Tip, paperTip } from '../../Today';
import { opensWords } from '../PaperSky';

const now = new Date('2026-11-04T12:00:00Z');
const name = (slug: string) => (slug === 'arxiv' ? 'arXiv' : slug);
const brief = {
  id: 7, title: 'Perovskite tandem cells held outdoors', authors: 'Ada Fixture, Ben Example', source: 'arxiv',
  first_seen_at: '2026-11-02T08:00:00Z', publication_date: '2026-10-30',
} as unknown as Parameters<typeof paperTip>[0]['brief'];

test('a paper\'s tip: its title first, then its authors, its source, its cell, and when it was collected', () => {
  expect(paperTip({ brief, now, cell: 'B3', sourceName: name, opens: 'Opens its page' })).toEqual({
    value: 'Perovskite tandem cells held outdoors',
    notes: ['Ada Fixture, Ben Example', 'arXiv · B3 · collected 2 days ago'],
    opens: 'Opens its page',
  });
  // While the paper is read, the tip names its cell and nothing else.
  expect(paperTip({ now, cell: 'B3', sourceName: name })).toEqual({ value: 'B3', opens: undefined });
});

test('what choosing a paper does, by map: beside the map, its page, or nothing for the page\'s own paper', () => {
  expect(opensWords('pointer', true, false)).toBe('Opens it beside the map');
  // From the keyboard the paper is already open beside the map once it is chosen.
  expect(opensWords('keyboard', true, false)).toBeUndefined();
  expect(opensWords('pointer', false, false)).toBe('Opens its page');
  expect(opensWords('keyboard', false, false)).toBe('Enter opens its page');
  expect(opensWords('pointer', false, true)).toBeUndefined();
});

test('the tip is set over the page, beside a box at the paper, not inside the map', () => {
  const plate = document.createElement('div');
  document.body.appendChild(plate);
  render(<Tip hover={{ index: 0, screenX: 120, screenY: 80, width: 600, height: 400 }} brief={brief} now={now} cell="B3"
    sourceName={name} opens="Opens it beside the map" />, { container: plate });
  const at = plate.querySelector<HTMLElement>('.plate-tip-at');
  expect(at?.style.left).toBe('120px');
  expect(at?.style.top).toBe('80px');
  const tip = screen.getByRole('tooltip');
  expect(plate.contains(tip)).toBe(false);
  expect(tip.querySelector('.chart-tip-value')?.textContent).toBe('Perovskite tandem cells held outdoors');
  expect(tip.querySelector('.chart-tip-opens')?.textContent).toBe('Opens it beside the map');
});
