/**
 * One vocabulary for the source wall's six states, and nowhere to drift to.
 *
 * `source_wall.STATE_LEGEND` in the backend is the only place these words are
 * written. The grid takes them off the payload, and so does the page's help
 * panel — which it did not, in the first draft of this branch, and the
 * consequences were visible within one commit: the panel headed its list
 * "What the six marks mean" and then listed five, and called a quiet field
 * *"answered, nothing new"* while the served key four inches above it said
 * *"answered, zero"*. Two names for one mark, on one screen, in a branch
 * whose own message claimed the second copy had been removed.
 *
 * This is the same failure as the one `ZeroReasonSurfaces.test.tsx` guards
 * one level down, and it is guarded the same way: by reading the Python and
 * refusing to let the TypeScript hold a copy.
 *
 * Three rules, and the third is the one that is easy to get wrong:
 *
 * 1. Every state in `WALL_STATES` has exactly one label in `STATE_LEGEND`.
 * 2. **No renderer source file writes one of the compound labels down.** A
 *    component that needs the word takes it off the payload. Only the labels
 *    that are more than one word are checked: `answered` and `failed` are
 *    ordinary English that 50-odd unrelated files in this renderer use for
 *    their own purposes, and a screen does not get to own a common word. The
 *    drift that happened was in a compound phrase, and compound phrases are
 *    where it can happen again. The tutorial is the single exception to the
 *    rule, and rule 3 is the price of it.
 * 3. The tutorial, which is long-form prose and cannot be served from an API,
 *    must name **every** label. So a state added to the backend turns this
 *    file red until the tutorial has been taught about it, rather than
 *    leaving a page of documentation quietly describing five of six marks.
 */

import * as fs from 'fs';
import * as path from 'path';
import { WALL_STATE_ORDER } from '../api/sourceWall';

const SRC = path.resolve(__dirname, '..');
const PYTHON_SOURCE = path.resolve(
  SRC, '..', '..', 'implementation_scripts', 'source_wall.py',
);
const TUTORIALS = path.join(SRC, 'components', 'AboutResmon', 'TutorialsTab.tsx');

/**
 * The `STATE_LEGEND` block, read out of the Python.
 *
 * Deliberately strict: every entry in the block must be a `{"state": ...,
 * "label": ..., "meaning": ...}` triple, and anything else stops the test
 * rather than being skipped. A silently skipped entry is how a guard comes to
 * agree with the thing it is guarding — the lesson written at length in
 * `scripts/generate-zero-reason.js`, which had exactly that bug.
 */
function pythonLegend(): { state: string; label: string }[] {
  const source = fs.readFileSync(PYTHON_SOURCE, 'utf8');
  const block = source.match(
    /STATE_LEGEND: tuple\[dict\[str, str\], \.\.\.\] = \(([\s\S]*?)\n\)\n/,
  );
  if (!block) throw new Error(`No STATE_LEGEND block in ${PYTHON_SOURCE}`);

  const entries = [...block[1].matchAll(/\{([\s\S]*?)\}/g)];
  if (entries.length === 0) throw new Error('STATE_LEGEND parsed to no entries');

  return entries.map((entry) => {
    const state = entry[1].match(/"state":\s*"([a-z_]+)"/);
    const label = entry[1].match(/"label":\s*"([^"]+)"/);
    const meaning = entry[1].match(/"meaning":\s*"([^"]+)"/);
    if (!state || !label || !meaning) {
      throw new Error(`STATE_LEGEND entry is not a state/label/meaning triple: ${entry[0]}`);
    }
    return { state: state[1], label: label[1] };
  });
}

function rendererFiles(): { file: string; text: string }[] {
  const walk = (dir: string): { file: string; text: string }[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      if (!/\.tsx?$/.test(entry.name)) return [];
      return [{ file: path.relative(SRC, full), text: fs.readFileSync(full, 'utf8') }];
    });
  return walk(SRC);
}

/** Comments may quote a label to explain why it is not written in code. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('the source wall’s six words live in one place', () => {
  const legend = pythonLegend();

  test('every state has exactly one label, and the order is the state order', () => {
    expect(legend.map((e) => e.state)).toEqual([...WALL_STATE_ORDER]);
    expect(new Set(legend.map((e) => e.label)).size).toBe(legend.length);
  });

  test('no renderer file writes one of the compound labels down', () => {
    const compound = legend.filter((e) => e.label.includes(' '));
    // This floor is what makes the compound-only rule safe, not a sanity
    // check on the parse. The rule skips single-word labels on purpose --
    // "answered" and "failed" appear in dozens of unrelated files and a
    // screen does not get to own a common English word. But that exemption
    // is only sound while the labels stay compound: shorten one to a single
    // word and it would silently leave the rule's scope. The count drops and
    // this reddens instead, so the rule cannot quietly shrink itself.
    expect(compound.length).toBeGreaterThanOrEqual(4);
    const exempt = new Set([
      // Prose about the marks, held to rule 3 below instead.
      path.relative(SRC, TUTORIALS),
      // The fixtures these rules are tested with.
      '__tests__/SourceWall.test.tsx',
      '__tests__/SourceWallVocabulary.test.ts',
      // The live Monitor's own help text, which predates this screen and
      // already spells two of these phrases out. It is not an oversight here
      // and it is not fixable here either: the Monitor is the one surface
      // with no served classification to take them from — a `repo_done`
      // event carries a reason slug and a sentence, never a category, which
      // is why `api/zeroReason.ts` exists at all. Exempt on that ground and
      // nothing wider.
      'pages/MonitorPage.tsx',
    ]);

    const offenders: string[] = [];
    for (const { file, text } of rendererFiles()) {
      if (exempt.has(file)) continue;
      const code = withoutComments(text);
      for (const { label } of compound) {
        if (code.includes(label)) offenders.push(`${file}: "${label}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the tutorial names every mark the backend serves', () => {
    const text = fs.readFileSync(TUTORIALS, 'utf8');
    const section = text.split("anchor: 'source-wall'")[1]?.split('destination:')[0] ?? '';
    expect(section.length).toBeGreaterThan(200);

    const missing = legend.filter((e) => !section.includes(e.label)).map((e) => e.label);
    expect(missing).toEqual([]);
  });

  test('the phrase this screen used to use for a quiet field is gone', () => {
    // It came from a brief rather than from the code, and it was the drift.
    const offenders = rendererFiles()
      // These two assert the phrase is *absent*, so they have to name it.
      .filter(({ file }) => file !== '__tests__/SourceWallVocabulary.test.ts')
      .filter(({ file }) => file !== '__tests__/SourceWall.test.tsx')
      .filter(({ text }) => withoutComments(text).includes('answered, nothing new'))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });
});
