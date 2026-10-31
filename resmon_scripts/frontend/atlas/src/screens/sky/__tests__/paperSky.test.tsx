import { useEffect } from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { useFocusOnArrival } from '../../arrival';
import { buildSky, type MapPoints, type MapRegion } from '../../today/model';
import { collectionSky } from '../collectionSky';
import { markLook } from '../PaperSky';

/** Six papers, ids 11 to 16. */
function points(): MapPoints {
  return {
    id: [11, 12, 13, 14, 15, 16],
    x: [0, 0.1, 0.2, 0.6, 0.7, 0.8],
    y: [0, 0.1, 0, 0.6, 0.7, 0.6],
    region: [0, 0, 0, 1, 1, 1],
    seen_day: [1000, 997, 990, 960, 900, 600],
  };
}
const REGIONS: MapRegion[] = [
  { id: 0, label: 'protein folding', terms: [], x: 0.1, y: 0.05, r: 0.3, size: 3 },
  { id: 1, label: 'traffic flow', terms: [], x: 0.7, y: 0.65, r: 0.3, size: 3 },
];
const sky = () => buildSky(points(), REGIONS, 1000);

describe('papers marked on a map of the whole collection', () => {
  test('nothing marked is the plain map, every paper lit in the ink', () => {
    expect(markLook(sky(), [])).toEqual({ look: null, placed: 0 });
  });

  test('the marked are lit in the accent and the rest dimmed; a paper the map has not placed is counted out', () => {
    const { look, placed } = markLook(sky(), [12, 15, 99]);
    expect(placed).toBe(2);
    expect(Array.from(look?.lit ?? [])).toEqual([0, 1, 0, 0, 1, 0]);
    expect(look?.colors).toEqual(['var(--accent-mark)']);
    // A few marked papers are each ringed.
    expect(Array.from(look?.found ?? []).sort()).toEqual([1, 4]);
  });

  test('the bright ones are ringed however many are marked, and only they', () => {
    const { look } = markLook(sky(), [11, 12, 13, 14], [13]);
    expect(Array.from(look?.found ?? [])).toEqual([2]);
  });

  test('past eighty marked papers, none is ringed: they are lit in the accent', () => {
    const many: MapPoints = { id: [], x: [], y: [], region: [], seen_day: [] };
    for (let i = 0; i < 120; i++) {
      many.id.push(i + 1); many.x.push(i / 120); many.y.push(0); many.region.push(0); many.seen_day.push(1000);
    }
    const { look, placed } = markLook(buildSky(many, REGIONS, 1000), many.id);
    expect(placed).toBe(120);
    expect(look?.found.length).toBe(0);
  });

  test('the whole collection is built once for each answer from the engine and each day', () => {
    const map = { points: points(), regions: REGIONS } as unknown as Parameters<typeof collectionSky>[0];
    const first = collectionSky(map, 1000);
    expect(collectionSky(map, 1000)).toBe(first);
    expect(collectionSky(map, 1001)).not.toBe(first);
    expect(first.sky.count).toBe(6);
  });
});

function Field() {
  useFocusOnArrival('field');
  return <input id="field" aria-label="Terms" />;
}

function Go({ to }: { to: string }) {
  const navigate = useNavigate();
  useEffect(() => { navigate(to); }, [navigate, to]);
  return null;
}

describe('the caret on arriving at a search', () => {
  test('a page arrived at by a link takes the caret in its field', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes><Route path="/" element={<Go to="/search" />} /><Route path="/search" element={<Field />} /></Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByLabelText('Terms')).toHaveFocus();
  });

  test('a page returned to, as by Back, or first opened, leaves the caret where it was', () => {
    render(<MemoryRouter initialEntries={['/search']}><Routes><Route path="/search" element={<Field />} /></Routes></MemoryRouter>);
    expect(screen.getByLabelText('Terms')).not.toHaveFocus();
  });

  test('another field that has the caret keeps it', async () => {
    const other = document.createElement('textarea');
    document.body.appendChild(other);
    other.focus();
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes><Route path="/" element={<Go to="/search" />} /><Route path="/search" element={<Field />} /></Routes>
      </MemoryRouter>,
    );
    await screen.findByLabelText('Terms');
    expect(other).toHaveFocus();
    other.remove();
  });
});
