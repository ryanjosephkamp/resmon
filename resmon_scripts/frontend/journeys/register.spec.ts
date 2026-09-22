/**
 * The guards that make the rest of this directory a denominator.
 *
 * Three things are checked here and all three fail the run rather than logging.
 *
 * 1. **Every built row has exactly one spec, and every spec has a row.** Both
 *    directions matter. One direction alone gives you either a register with
 *    rows nothing tests, or a suite of tests that has quietly stopped covering
 *    the register.
 * 2. **A row that is not built names the slice that owes it**, and a row that
 *    is not carried forward names the decision that dropped it. Nothing leaves
 *    the register silently.
 * 3. **No spec reaches the renderer.** Everything goes through the driver, so
 *    the 3.0 renderer supplies one file rather than forty-four rewrites.
 *
 * These are plain filesystem reads: there is no app to launch to know whether a
 * file exists. They run first because they are named `register.spec.ts` and the
 * runner sorts files, which means a run whose register has drifted says so
 * before spending twenty minutes launching Electron.
 */
import * as fs from 'fs';
import * as path from 'path';
import { test, expect } from '@playwright/test';
import {
  ALLOWED_SPEC_IMPORTS, FORBIDDEN_RENDERER_PATTERNS, JOURNEY_REGISTER,
  builtRows, pendingRows, specStem,
} from './register';

const HERE = __dirname;
const GUARD = 'register.spec.ts';

/** Every spec file in this directory, the guard included. */
function specFiles(): string[] {
  return fs.readdirSync(HERE).filter((name) => name.endsWith('.spec.ts')).sort();
}

/** The spec files that claim a register row: `J<nn>-<slug>.spec.ts`. */
function journeySpecFiles(): string[] {
  return specFiles().filter((name) => /^J\d{2}-/.test(name));
}

test.describe('the journey register and this directory agree', () => {
  test('every register ID is unique, well formed, and in order', () => {
    const ids = JOURNEY_REGISTER.map((row) => row.id);
    expect(new Set(ids).size, 'a register ID appears twice').toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^J\d{2}$/);
    expect([...ids].sort(), 'the register is not in ID order').toEqual(ids);
    expect(JOURNEY_REGISTER.length, 'the parity register has 44 journeys').toBe(44);
  });

  test('every built row has exactly one spec named for it', () => {
    const present = journeySpecFiles();
    const missing: string[] = [];
    for (const row of builtRows()) {
      const expected = `${specStem(row)}.spec.ts`;
      const forThisRow = present.filter((name) => name.startsWith(`${row.id}-`));
      if (forThisRow.length !== 1 || forThisRow[0] !== expected) {
        missing.push(`${row.id} (${row.title}) wants exactly ${expected}; found ${forThisRow.join(', ') || 'nothing'}`);
      }
    }
    expect(missing, 'a carried row in the built slice has no spec, or has more than one').toEqual([]);
  });

  test('every spec maps to a carried row of the built slice', () => {
    const built = new Set(builtRows().map((row) => `${specStem(row)}.spec.ts`));
    const stray = journeySpecFiles().filter((name) => !built.has(name));
    expect(stray, 'a spec file claims a row the register does not have in this slice').toEqual([]);
    // And nothing in the directory is a spec that claims no row at all, other
    // than this guard itself.
    const unclaimed = specFiles().filter((name) => name !== GUARD && !/^J\d{2}-/.test(name));
    expect(unclaimed, 'a spec here is named for no register row').toEqual([]);
  });

  test("every spec's first describe title starts with its row ID", () => {
    const wrong: string[] = [];
    for (const name of journeySpecFiles()) {
      const id = name.slice(0, 3);
      const source = fs.readFileSync(path.join(HERE, name), 'utf8');
      const describe = /describe\(\s*(['"`])([\s\S]*?)\1/.exec(source);
      if (!describe) { wrong.push(`${name} has no describe block`); continue; }
      if (!describe[2].startsWith(id)) wrong.push(`${name} opens with "${describe[2]}"`);
    }
    expect(wrong, 'a spec does not say which row it is').toEqual([]);
  });

  test('a pending row names the slice that owes it, and a dropped row names its decision', () => {
    const unslotted = pendingRows().filter((row) => !['2a', '2b'].includes(row.slice));
    expect(unslotted.map((r) => r.id), 'a pending row belongs to no slice').toEqual([]);

    const dropped = JOURNEY_REGISTER.filter((row) => row.status === 'not_carried_forward');
    const unexplained = dropped.filter((row) => !row.reason || !row.reason.trim());
    expect(
      unexplained.map((r) => r.id),
      'a row left the register with no N-row and no initials (B4)',
    ).toEqual([]);
  });

  test('the suite prints how much of the register it covers', () => {
    const pending = pendingRows();
    const bySlice = ['2a', '2b']
      .map((s) => `${pending.filter((r) => r.slice === s).length} in slice ${s}`)
      .join(', ');
    const line = `${builtRows().length} of ${JOURNEY_REGISTER.length} rows have a journey test; `
      + `${pending.length} pending (${bySlice}).`;
    console.log(`[journeys] ${line}`);
    // The count is the register's, not a number typed here: this asserts only
    // that the three groups partition it, which is what makes the printed
    // sentence safe to quote.
    expect(builtRows().length + pending.length
      + JOURNEY_REGISTER.filter((r) => r.status === 'not_carried_forward').length)
      .toBe(JOURNEY_REGISTER.length);
  });
});

test.describe('no spec reaches the renderer except through the driver', () => {
  test('no spec file contains a renderer call', () => {
    const hits: string[] = [];
    for (const name of specFiles()) {
      const lines = fs.readFileSync(path.join(HERE, name), 'utf8').split('\n');
      lines.forEach((line, index) => {
        for (const { name: token, pattern } of FORBIDDEN_RENDERER_PATTERNS) {
          if (pattern.test(line)) hits.push(`${name}:${index + 1} uses ${token}: ${line.trim()}`);
        }
      });
    }
    expect(
      hits,
      'a journey spec reaches the renderer directly, which is the one thing that would '
      + 'make this suite un-runnable against the 3.0 build',
    ).toEqual([]);
  });

  test('no spec file imports anything but the driver', () => {
    const hits: string[] = [];
    for (const name of specFiles()) {
      if (name === GUARD) continue; // the guard reads the directory; that is its job
      const source = fs.readFileSync(path.join(HERE, name), 'utf8');
      // Anchored to the start of a line, because an unanchored `from` matches
      // English: "the new run does not record where it came from', " read as an
      // import of everything up to the next quote. The guard's first run found
      // exactly that, which is a useful reminder that a guard is code too.
      const imports = /^\s*(?:import\b[\s\S]*?from|(?:const|let|var)\b[\s\S]*?=\s*require\()\s*(['"])([^'"]+)\1/gm;
      for (const match of source.matchAll(imports)) {
        if (!ALLOWED_SPEC_IMPORTS.includes(match[2])) {
          hits.push(`${name} imports ${match[2]}`);
        }
      }
    }
    expect(
      hits,
      'a journey spec imports something other than the driver — which is how a selector '
      + 'gets built somewhere the grep above does not look',
    ).toEqual([]);
  });

  test('the guard itself is a static check and launches nothing', () => {
    // If this file ever grew a driver import it would become a journey, and the
    // "every spec has a row" rule above would have to exempt it — which is the
    // hole this suite is trying not to have.
    const source = fs.readFileSync(path.join(HERE, GUARD), 'utf8');
    expect(/from\s+'\.\/driver'/.test(source)).toBe(false);
  });
});

/**
 * One named row made to fail on purpose, so the two CI legs can be shown red.
 *
 * `RESMON_JOURNEY_BREAK_ROW=J20` makes exactly that row's guard fail and
 * nothing else — the same shape as `RESMON_E2E_BREAK_ROUTE` next door, and for
 * the same reason: B2 says a new CI job is trusted once it has been made to go
 * red, and a job that cannot be made to go red on demand has to be trusted on
 * somebody's word instead.
 */
test('a named row can be broken on purpose', () => {
  const broken = (process.env.RESMON_JOURNEY_BREAK_ROW || '').trim();
  test.skip(!broken, 'RESMON_JOURNEY_BREAK_ROW is unset; nothing is being broken');
  const row = JOURNEY_REGISTER.find((r) => r.id === broken);
  expect(row, `RESMON_JOURNEY_BREAK_ROW names ${broken}, which is not a register row`).toBeTruthy();
  expect(
    broken,
    `${broken} (${row?.title}) was failed on purpose by RESMON_JOURNEY_BREAK_ROW`,
  ).toBe('');
});
