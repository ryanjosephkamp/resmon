/**
 * Every Tutorial button must land on a real tutorial section.
 *
 * TutorialsTab resolves a hash by prefixing it: hash ``analytics`` scrolls to
 * the element with id ``tutorial-analytics``. A page that passed the already-
 * prefixed form produced ``tutorial-tutorial-analytics``, so the button
 * navigated to the Tutorials tab and then sat at the top of it — silently, with
 * nothing to indicate the deep link had failed. The Analytics page shipped that
 * way. This test is cheap and would have caught it.
 */

import fs from 'fs';
import path from 'path';

const SRC = path.resolve(__dirname, '..');

function readAll(dir: string): { file: string; text: string }[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return readAll(full);
    if (!/\.tsx?$/.test(entry.name)) return [];
    return [{ file: full, text: fs.readFileSync(full, 'utf8') }];
  });
}

describe('Tutorial deep links', () => {
  const files = readAll(SRC);

  const anchors = files.flatMap(({ file, text }) =>
    [...text.matchAll(/TutorialLinkButton\s+anchor="([^"]+)"/g)].map((m) => ({
      file: path.relative(SRC, file),
      anchor: m[1],
    })),
  );

  const tutorialsTab = files.find((f) => f.file.endsWith('TutorialsTab.tsx'))!;
  const sectionAnchors = new Set(
    [...tutorialsTab.text.matchAll(/anchor:\s*'([^']+)'/g)].map((m) => m[1]),
  );

  test('there are buttons and sections to check', () => {
    expect(anchors.length).toBeGreaterThan(10);
    expect(sectionAnchors.size).toBeGreaterThan(10);
  });

  test('no button passes an already-prefixed anchor', () => {
    const prefixed = anchors.filter(
      (a) => a.anchor.startsWith('#') || a.anchor.startsWith('tutorial-'),
    );
    expect(prefixed).toEqual([]);
  });

  test('every button anchor names a section that exists', () => {
    const orphans = anchors.filter((a) => !sectionAnchors.has(a.anchor));
    expect(orphans).toEqual([]);
  });
});
