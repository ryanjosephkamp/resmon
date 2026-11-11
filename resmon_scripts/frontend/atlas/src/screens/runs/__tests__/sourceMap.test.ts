import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { contrast } from '../../../theme/accent';
import { buildSky } from '../../today/model';
import { runMapIds, runSourceLook, sourceChoices, sourcesFor, OTHER_SOURCES, type RunMembership } from '../sourceMap';

const data: RunMembership = { ids: [1, 2, 3], sources: ['arxiv', 'plos'], papers: [
  { id: 1, copies: [1, 2], sources: ['arxiv', 'plos'] }, { id: 3, copies: [3], sources: ['plos'] },
] };
const points = { id: [2, 3], x: [0, 1], y: [0, 1], region: [0, 0], seen_day: [0, 0] };
test('one placed copy per DOI, all source names, and source selection removes the other papers', () => {
  expect(runMapIds(data, points, null)).toEqual([2, 3]);
  expect(runMapIds(data, points, 'arxiv')).toEqual([2]);
  expect(sourcesFor(data, 2, (x) => x)).toBe('arxiv, plos');
  expect(sourceChoices(data, (x) => x).map((c) => c.count)).toEqual([1, 2]);
  expect(Array.from(runSourceLook(buildSky(points, [], 0), data, null).group!)).toEqual([0, 1]);
});
test('source colors remain fixed as sources arrive; overflow is named Other Sources', () => {
  const many = { ...data, sources: ['a', 'b', 'c', 'd', 'e', 'f', 'arxiv', 'plos'] };
  const choices = sourceChoices(many, (x) => x);
  expect(choices).toHaveLength(7);
  expect(choices[6]).toMatchObject({ key: OTHER_SOURCES, label: 'Other Sources', sources: ['arxiv', 'plos'], count: 2 });
  expect(new Set(choices.map((c) => c.color)).size).toBe(7);
  expect(sourceChoices({ ...data, papers: [] }, (x) => x)[1]?.color).toBe(sourceChoices(data, (x) => x)[1]?.color);
});
test('the fixed source palette clears 3:1 against each theme at the plate opacity', () => {
  const css = readFileSync(join(__dirname, '../../sky/regionColors.css'), 'utf8');
  for (const theme of ['dark', 'light']) {
    const block = css.split(`data-theme="${theme}"`)[1]!.split('}')[0]!;
    const colors = [...block.matchAll(/--region-\d:\s*(#[a-fA-F0-9]{6})/g)].map((m) => m[1]!);
    expect(colors).toHaveLength(6);
    const tokenCss = readFileSync(join(__dirname, '../../../theme/tokens.css'), 'utf8');
    const start = tokenCss.indexOf(`:root[data-theme="${theme}"]`);
    const tokens = tokenCss.slice(start, tokenCss.indexOf('}', start));
    colors.push(tokens.match(/--ink-2:\s*(#[a-fA-F0-9]{6})/)![1]!);
    const ground = theme === 'dark' ? '#0a0a0b' : '#ffffff';
    for (const color of colors) {
      const blend = '#' + [1, 3, 5].map((i) => Math.round(0.7 * parseInt(color.slice(i, i + 2), 16)
        + 0.3 * parseInt(ground.slice(i, i + 2), 16)).toString(16).padStart(2, '0')).join('');
      expect(contrast(blend, ground)).toBeGreaterThanOrEqual(3);
    }
  }
});
