/**
 * Every list Atlas writes in words takes the serial comma: "A, B, and C".
 *
 * The helpers are checked by what they return, and the source is read for the
 * shape that wrote "A, B and C" by hand, so a list written later without a
 * helper fails here rather than on a screen.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { listed } from '../screens/watches/window';
import { listWords } from '../screens/today/format';
import { listWords as choiceList } from '../screens/settings/summaryChoice';
import { runNumbers } from '../screens/runs/model';

describe('the list helpers', () => {
  test.each([listed, listWords, choiceList])('%#: one, two, and three or more', (join) => {
    expect(join(['arXiv'])).toBe('arXiv');
    expect(join(['arXiv', 'DOAJ'])).toBe('arXiv and DOAJ');
    expect(join(['Crossref', 'HAL', 'OpenAlex'])).toBe('Crossref, HAL, and OpenAlex');
  });

  test('run numbers', () => {
    expect(runNumbers([12, 4, 9])).toBe('runs 4, 9, and 12');
  });
});

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sources(path);
    return /\.tsx?$/.test(name) && !name.endsWith('.d.ts') ? [path] : [];
  });
}

test('no list in the source joins its last item without the serial comma', () => {
  const root = join(__dirname, '..');
  // `${items.slice(0, -1).join(', ')} and ${last}`, and the "and N more" form of it.
  const unserial = /join\(', '\)\}\s+(and|or)\s/;
  const found = sources(root).flatMap((path) => readFileSync(path, 'utf8').split('\n')
    .map((line, i) => ({ at: `${relative(root, path)}:${i + 1}`, line }))
    .filter(({ line }) => unserial.test(line)));
  expect(found).toEqual([]);
});
