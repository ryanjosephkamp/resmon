/**
 * A paper's cover in the Library: its piece of the collection map answers the
 * pointer with the charts' tip, naming the paper's cell and region and that
 * the crossed star is this paper, or that the map has not placed it. The card
 * already opens the paper, so the tip offers no click of its own.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { buildSky, type MapPoints, type MapRegion } from '../../today/model';
import { AtlasCover, coverTip } from '../Cover';

if (!('PointerEvent' in window)) {
  class PointerEventShim extends MouseEvent {}
  Object.defineProperty(window, 'PointerEvent', { value: PointerEventShim, configurable: true });
}

const POINTS: MapPoints = {
  id: [11, 12, 13, 14], x: [0, 0.1, 0.6, 0.7], y: [0, 0.1, 0.6, 0.7], region: [0, 0, 1, 1], seen_day: [1000, 990, 960, 900],
};
const REGIONS: MapRegion[] = [
  { id: 0, label: 'protein folding', terms: [], x: 0.05, y: 0.05, r: 0.2, size: 2 },
  { id: 1, label: 'traffic flow', terms: [], x: 0.65, y: 0.65, r: 0.2, size: 2 },
];
const atlas = () => ({ sky: buildSky(POINTS, REGIONS, 1000), regions: REGIONS });

test('the tip names the paper\'s cell and region, and says the crossed star is this paper', () => {
  expect(coverTip({ cell: 'B7', label: { text: 'protein folding' } })).toEqual({
    name: 'On the collection map', value: 'B7, protein folding',
    notes: ['The crossed star is this paper; the others are the papers nearest it on the map.'],
  });
  expect(coverTip({ cell: 'B7', label: null }).value).toBe('B7');
  expect(coverTip(null)).toEqual({ name: 'On the collection map', value: 'Not on the map yet', notes: ['It is placed when the map is next drawn.'] });
});

test('the pointer over a placed paper\'s cover shows its place, and no click of its own', () => {
  render(<AtlasCover atlas={atlas()} documentId={12} title="A paper" who="Ada Fixture" venue="arXiv" year="2026" />);
  const cover = document.querySelector<HTMLElement>('[data-cover="atlas"]')!;
  expect(cover).toHaveAttribute('data-placed', 'true');
  fireEvent.pointerEnter(cover, { clientX: 40, clientY: 40 });
  const tip = screen.getByRole('tooltip');
  expect(tip.querySelector('.chart-tip-value')?.textContent).toMatch(/^[A-H][1-8], protein folding$/);
  expect(tip.querySelector('.chart-tip-opens')).toBeNull();
  fireEvent.pointerLeave(cover);
  expect(screen.queryByRole('tooltip')).toBeNull();
});

test('a paper the map has not placed says so; while the map is read, the cover has no tip', () => {
  const { unmount } = render(<AtlasCover atlas={atlas()} documentId={99} title="Unplaced" who="" venue="" year={null} />);
  fireEvent.pointerEnter(document.querySelector<HTMLElement>('[data-cover="atlas"]')!, { clientX: 40, clientY: 40 });
  expect(screen.getByRole('tooltip').querySelector('.chart-tip-value')?.textContent).toBe('Not on the map yet');
  unmount();
  render(<AtlasCover atlas={null} documentId={12} title="Reading" who="" venue="" year={null} />);
  fireEvent.pointerEnter(document.querySelector<HTMLElement>('[data-cover="atlas"]')!, { clientX: 40, clientY: 40 });
  expect(screen.queryByRole('tooltip')).toBeNull();
});
