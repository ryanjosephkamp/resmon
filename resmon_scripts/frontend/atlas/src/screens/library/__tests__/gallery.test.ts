import { buildSky, type MapRegion } from '../../today/model';
import { cropFor, VIEW } from '../coverChart';
import {
  columnsFor, fileLabel, firstLines, goesWith, paperLabel, pick, pickedWords, projectCounts, removedWords, rowEstimate,
  shortWho, showFrom, sortFrom, sourceUrl, yearOf,
} from '../galleryModel';

test('the shelf and its order come from the address, with the defaults for anything else', () => {
  expect(showFrom(null)).toBe('to_read');
  expect(showFrom('files')).toBe('files');
  expect(showFrom('everything')).toBe('to_read');
  expect(sortFrom('to_read', 'map')).toBe('map');
  expect(sortFrom('files', 'map')).toBe('newest');
  expect(sortFrom('projects', null)).toBe('changed');
});

test('covers fit the row at their least width, and two a row under the phone width', () => {
  expect(columnsFor(0)).toBe(1);
  expect(columnsFor(390 - 32)).toBe(2);
  expect(columnsFor(848)).toBe(3);
  expect(columnsFor(1328)).toBe(5);
  expect(columnsFor(1840)).toBe(7);
  // A row's height is a page's at the column's width, and its caption.
  expect(rowEstimate(1328, 5)).toBeGreaterThan(Math.round(((1328 - 96) / 5) * (792 / 612)));
});

test('a paper says the run that first found it and the day it was saved, and never where it was saved from', () => {
  const now = new Date('2026-11-04T12:00:00Z');
  const saved = '2026-11-03 08:00:00';
  expect(paperLabel({ saved_at: saved, found_by: null }, now)).toEqual({ from: null, name: false, day: 'November 3' });
  expect(paperLabel({ saved_at: saved, found_by: { execution_id: 1, kind: 'watch', watch_id: 2, watch_name: 'muon g-2', at: '' } }, now))
    .toEqual({ from: 'muon g-2', name: true, day: 'November 3' });
  expect(paperLabel({ saved_at: saved, found_by: { execution_id: 1, kind: 'watch', watch_id: null, watch_name: null, at: '' } }, now).from)
    .toBe('a watch');
  expect(paperLabel({ saved_at: '2025-02-01 08:00:00', found_by: { execution_id: 1, kind: 'search', watch_id: null, watch_name: null, at: '' } }, now))
    .toEqual({ from: 'a search', name: false, day: 'February 1, 2025' });
});

test('the lines under a cover', () => {
  expect(shortWho('Priya Raman, Tomás Echeverría')).toBe('Priya Raman et al.');
  expect(shortWho('Ada Lovelace')).toBe('Ada Lovelace');
  expect(shortWho(null)).toBe('Authors not recorded');
  expect(yearOf('2026-04-13')).toBe('2026');
  expect(yearOf('in press')).toBeNull();
  expect(fileLabel({ paper_links: [], project_count: 0, availability: 'not_checked' })).toBe('Not linked to a paper');
  expect(fileLabel({ paper_links: [{} as never], project_count: 2, availability: 'not_checked' })).toBe('Linked to 1 paper, in 2 projects');
  expect(fileLabel({ paper_links: [], project_count: 1, availability: 'not_checked' })).toBe('In 1 project');
  expect(fileLabel({ paper_links: [], project_count: 0, availability: 'missing' })).toMatch(/^Not in the Library folder/);
  expect(projectCounts({ file_count: 6, note_count: 16, passage_count: 14 })).toEqual(['6 files', '14 passages', '2 notes']);
  expect(projectCounts({ file_count: 1, note_count: 0, passage_count: 0 })).toEqual(['1 file']);
});

test('a paper opens at its own web address, or at its DOI, and never at anything else', () => {
  expect(sourceUrl({ url: 'https://arxiv.org/abs/2611.01847', doi: '10.1/x' })).toBe('https://arxiv.org/abs/2611.01847');
  expect(sourceUrl({ url: 'javascript:alert(1)', doi: '10.48550/arXiv.2611.01847' })).toBe('https://doi.org/10.48550/arXiv.2611.01847');
  expect(sourceUrl({ url: 'file:///etc/passwd', doi: null })).toBeNull();
});

test('a text cover is the file\'s first lines, literal', () => {
  expect(firstLines('a\r\nb\rc\n', 2)).toEqual(['a', 'b']);
  expect(firstLines('one').length).toBe(1);
});

test('a click picks one card, and a Shift-click the run from the last one in gallery order', () => {
  const order = ['a', 'b', 'c', 'd', 'e'];
  let picked = pick(order, new Set(), null, 'b', false);
  expect([...picked]).toEqual(['b']);
  picked = pick(order, picked, 'b', 'd', true);
  expect([...picked].sort()).toEqual(['b', 'c', 'd']);
  picked = pick(order, picked, 'd', 'c', false);
  expect([...picked].sort()).toEqual(['b', 'd']);
  // Backward, and with no card clicked before, a Shift-click is one card.
  expect([...pick(order, new Set(), 'e', 'c', true)].sort()).toEqual(['c', 'd', 'e']);
  expect([...pick(order, new Set(), null, 'c', true)]).toEqual(['c']);
  expect(pickedWords(3, 14)).toBe('3 of 14 picked');
  expect(pickedWords(2, null)).toBe('2 picked');
});

test('the notice and the question before a removal name what goes', () => {
  expect(removedWords(['A paper'], 'To read')).toEqual({ lead: 'Removed ', name: 'A paper', rest: ' from To read.' });
  expect(removedWords(['a', 'b', 'c'], 'Your files')).toEqual({ lead: 'Removed 3 from Your files.', name: null, rest: '' });
  expect(goesWith({ links: [1, 2], projects: [{ name: 'Muon', member: true, notes: 2, passages: 1 }, { name: 'Old', member: false, notes: 1, passages: 0 }] }))
    .toEqual(['Muon: its place in the project, 1 passage, 2 notes', 'Old: 1 note', 'Its 2 links to papers in your collection']);
});

describe('a paper\'s piece of the map', () => {
  const regions: MapRegion[] = [{ id: 0, label: 'surface code · qubits', terms: [], x: -0.5, y: 0.5, r: 0.2, size: 3 }];
  const points = { id: [1, 2, 3, 4], x: [-0.5, -0.48, -0.55, 0.9], y: [0.5, 0.52, 0.45, -0.9], region: [0, 0, 0, 0], seen_day: [100, 100, 90, 10] };
  const sky = buildSky(points, regions, 100);

  test('is the map\'s own: the paper where it sits, its neighbors, its region and its cell', () => {
    const crop = cropFor(sky, regions, 1)!;
    expect(crop.at.x).toBeGreaterThan(VIEW.left);
    expect(crop.at.x).toBeLessThan(VIEW.left + VIEW.inner);
    expect(crop.at.y).toBeGreaterThan(VIEW.top);
    expect(crop.at.y).toBeLessThan(VIEW.top + VIEW.innerHeight);
    // Two neighbors inside the crop, drawn as paths by brightness; the far paper is not.
    const drawn = crop.stars.map((s) => s.d).join('').match(/M/g)?.length ?? 0;
    expect(drawn).toBe(2);
    expect(crop.label?.text).toBe('surface code · qubits');
    expect(crop.cell).toMatch(/^[A-H][1-8]$/);
    expect(crop.columns.some((c) => c.here && c.text === crop.cell[0])).toBe(true);
    expect(crop.rows.some((r) => r.here && r.text === crop.cell.slice(1))).toBe(true);
  });

  test('is nothing for a paper the map has not placed', () => {
    expect(cropFor(sky, regions, 99)).toBeNull();
  });

  test('is the same every time it is drawn', () => {
    expect(cropFor(sky, regions, 2)).toEqual(cropFor(sky, regions, 2));
  });
});
