import { fireEvent, render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { contrast } from '../../../theme/accent';
import { buildSky, type MapRegion } from '../../today/model';
import { colorsBy, DEFAULT_VIEW } from '../look';
import { MapBar } from '../MapControls';

const regions: MapRegion[] = [
  { id: 0, label: 'Protein', terms: [], x: 0, y: 0, r: 0.4, size: 3 },
  { id: 1, label: 'Quantum', terms: [], x: 1, y: 0, r: 0.4, size: 1 },
  { id: 2, label: 'Agents', terms: [], x: 0, y: 1, r: 0.4, size: 2 },
];

test('neighboring regions wear different colors, visible against the plate in both themes', () => {
  const sky = buildSky({ id: [1, 2, 3], x: [0, 1, 0], y: [0, 0, 1], region: [0, 1, 2], seen_day: [0, 0, 0] }, regions, 0);
  const colored = colorsBy(sky, null, 'region', (slug) => slug);
  expect(colored.group).not.toBeNull();
  expect(new Set(colored.group)).toHaveProperty('size', 3);
  const css = readFileSync(join(__dirname, '../regionColors.css'), 'utf8');
  for (const theme of ['dark', 'light']) {
    const block = css.split(`data-theme="${theme}"`)[1]!.split('}')[0]!;
    const colors = [...block.matchAll(/--region-\d:\s*(#[a-fA-F0-9]{6})/g)].map((m) => m[1]!);
    expect(colors).toHaveLength(6);
    for (const color of colors) {
      const ground = theme === 'dark' ? '#0a0a0b' : '#ffffff';
      expect(contrast(color, ground)).toBeGreaterThanOrEqual(3);
      // The plate draws a colored mark at no less than 70% opacity before
      // density dimming, so check the visible blend as well as the swatch.
      const blend = '#' + [1, 3, 5].map((i) => Math.round(0.7 * parseInt(color.slice(i, i + 2), 16)
        + 0.3 * parseInt(ground.slice(i, i + 2), 16)).toString(16).padStart(2, '0')).join('');
      expect(contrast(blend, ground)).toBeGreaterThanOrEqual(3);
    }
    for (const a of colors) for (const b of colors) {
      if (a === b) continue;
      const rgb = (s: string) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16) / 255);
      const x = rgb(a), y = rgb(b);
      expect(Math.hypot(...x.map((v, i) => v - y[i]!))).toBeGreaterThan(0.3);
    }
  }
});

test('region choices can be sorted and filtered, and choosing one narrows the map', () => {
  const change = jest.fn();
  render(<MapBar name="run" view={DEFAULT_VIEW} onView={() => undefined} look={null} facts={null} facetsError={null}
    total={6} names={(x) => x} find={{ typed: '', setTyped: () => undefined, finding: false, waiting: false, error: null }}
    findAt={0} onStep={() => undefined} onWant={() => undefined}
    {...{ regions: { choices: regions.map((r) => ({ id: r.id, label: r.label, count: r.size, color: 'blue' })), selected: [], onSelect: change } }} />);
  const list = screen.getByRole('group', { name: 'Regions' });
  fireEvent.change(within(list).getByLabelText('Sort Regions'), { target: { value: 'name' } });
  expect(within(list).getAllByRole('checkbox').map((c) => c.getAttribute('aria-label'))).toEqual(['Agents', 'Protein', 'Quantum']);
  fireEvent.change(within(list).getByLabelText('Find a Region'), { target: { value: 'quant' } });
  expect(within(list).getAllByRole('checkbox')).toHaveLength(1);
  fireEvent.click(within(list).getByRole('checkbox', { name: 'Quantum' }));
  expect(change).toHaveBeenCalledWith([1]);
});

test('a run sky keeps the lexical labels and centers of its displayed regions', () => {
  const { subSky } = jest.requireActual<typeof import('../../today/model')>('../../today/model');
  const run = subSky({ id: [1, 2], x: [0, 1], y: [0, 0], region: [0, 1], seen_day: [0, 0] }, regions, [1, 2], 0);
  const colored = colorsBy(run.sky, null, 'region', (slug) => slug);
  expect(colored.legend.map((r) => r.label)).toEqual(['Protein', 'Quantum']);
});
