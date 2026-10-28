/**
 * The guards that make the rest of this directory a denominator.
 *
 * Four things are checked here and all four fail the run rather than logging.
 *
 * 1. **Every built row has exactly one spec, and every spec has a row.** Both
 *    directions matter. One direction alone gives you either a register with
 *    rows nothing tests, or a suite of tests that has quietly stopped covering
 *    the register.
 * 2. **A row that is not built names the slice that owes it**, and a row that
 *    is not carried forward names the decision that dropped it. Nothing leaves
 *    the register silently.
 * 3. **No spec reaches the renderer.** Everything goes through the driver, so
 *    the 3.0 renderer supplies one file rather than forty-five rewrites.
 * 4. **Every page the app routes to names the rows that carry it.** The first
 *    three compare the register with this directory; this one compares it
 *    with the app, which nothing did until the Source wall had been a page
 *    with no row for nine days.
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
  ALLOWED_SPEC_IMPORTS, FORBIDDEN_RENDERER_PATTERNS, JOURNEY_REGISTER, LATER_SLICES, ROUTE_ROWS,
  builtRows, pendingRows, specStem,
} from './register';
import { allRouteHashes } from '../src/routes';

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
    expect(JOURNEY_REGISTER.length, 'the parity register has 47 journeys').toBe(47);
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
    const unslotted = pendingRows().filter((row) => !LATER_SLICES.includes(row.slice));
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
    const bySlice = LATER_SLICES
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

test.describe('the journey register and the app agree', () => {
  test('every page the app routes to names the rows that carry it', () => {
    // The smoke suite's own denominator: every top-level route and every
    // Settings and About tab, read from the table `App.tsx` renders.
    const hashes = allRouteHashes().map((route) => route.hash);
    const unmapped = hashes.filter((hash) => !(hash in ROUTE_ROWS));
    expect(
      unmapped,
      'a page the app routes to has no register row — add a row and its spec, or say in '
      + 'ROUTE_ROWS which existing row carries what a person does there',
    ).toEqual([]);
    const stale = Object.keys(ROUTE_ROWS).filter((hash) => !hashes.includes(hash));
    expect(stale, 'ROUTE_ROWS names a page the app no longer routes to').toEqual([]);
    const carried = new Set(JOURNEY_REGISTER.filter((row) => row.status === 'carried').map((row) => row.id));
    const orphaned = Object.entries(ROUTE_ROWS).flatMap(([hash, { rows }]) => (rows.length
      ? rows.filter((id) => !carried.has(id)).map((id) => `${hash} → ${id}`)
      : [`${hash} → no row at all`]));
    expect(orphaned, 'a page is said to be carried by a row the register does not carry').toEqual([]);
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
 * The driver may not wait for a duration, and may not read before it has
 * waited for something.
 *
 * **This is the class, not the incident.** J03 read a routine's `active` flag
 * on the line after activating it and failed in three seconds against a
 * healthy seven-second run: five red Journeys jobs across four branches and
 * four dates, one of them on a pull request whose entire content was one word
 * in a markdown file. A red Journeys job reads as "this branch broke a
 * journey", so each occurrence cost somebody half an hour ruling out their own
 * diff, and three different people paid it. Slice 4 removed `goto`'s trailing
 * 400 ms — the last duration the suite leaned on — and exposed six reads that
 * had been living behind it; slice 5 was written to sweep the rest and was
 * never dispatched. These two tests are that sweep made permanent.
 *
 * A duration is the tell. It is not a wait for anything: it is a guess about
 * how long something takes on the machine the author happened to be using, and
 * every one of them is a flake waiting for a loaded runner.
 */
const DRIVERS = path.join(HERE, 'drivers');

/** A read of the screen. The same list the sweep's denominator was taken from. */
const SCREEN_READS = [
  'innerText()', 'allInnerTexts()', '.count()', 'inputValue()',
  'isChecked()', 'getAttribute(', 'isVisible()', 'isEnabled()',
];

/**
 * Something that is a wait for a *state*: an assertion, a poll, a response, a
 * `goto` (which waits for the destination's own landmark), or `stored`, the
 * driver's own "the app has recorded it" predicate.
 */
const SETTLES = /expect\s*\(|expect\.poll|waitForResponse|waitForFunction|\.waitFor\(|waitForLoadState|\bstored\(|\bgoto\(/;

/**
 * Driver methods whose first screen read has no wait in front of it, each with
 * the reason it is sound. The list is here rather than absent so that adding
 * to it is a decision somebody makes in a diff.
 */
const UNSETTLED_FIRST_READ_IS_SOUND: Record<string, string> = {
  readTabsHere: 'reads markup the place renders on mount; the spec reaches it through open(), whose landmark wait is the settle',
  framesHere: 'the same: a count of the frames a mounted place draws, taken after open()',
  readExternalLinks: 'the same, for the links on a mounted place',
  askTheAssistant: 'the count is a presence probe deciding whether to open the panel, not a measurement; the turn it then reads is settled by theTurnHasStoppedMoving',
  readSavedConversations: 'the same probe; the list it then reads is held against the number of sessions the app says it has',
  readTheAssistantPanel: 'the same probe, reporting whether the panel is open at all',
  readTheTurnsChoices: 'runs on a turn askTheAssistant has already settled; the count is of blocks that turn produced',
};

/** Every `name: (…)` method of the driver object, with its body. */
function driverMethods(source: string): { name: string; body: string[] }[] {
  const lines = source.split('\n');
  const starts: { name: string; line: number }[] = [];
  lines.forEach((line, index) => {
    const match = line.match(/^ {4}([A-Za-z_][A-Za-z0-9_]*): (?:async )?[({<]/);
    if (match) starts.push({ name: match[1], line: index });
  });
  return starts.map((start, i) => ({
    name: start.name,
    body: lines.slice(start.line, i + 1 < starts.length ? starts[i + 1].line : lines.length),
  }));
}

/** A line with its comments stripped, so a read named in prose is not a read. */
function code(line: string): string {
  return line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
}

test.describe('the driver waits for states, not for durations', () => {
  test('no driver waits for a duration without saying why on the line', () => {
    const hits: string[] = [];
    for (const name of fs.readdirSync(DRIVERS).filter((f) => f.endsWith('.ts'))) {
      const lines = fs.readFileSync(path.join(DRIVERS, name), 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (!/waitForTimeout\(/.test(code(line))) return;
        // One escape hatch, and it has to be used out loud. `journeys:duration-ok`
        // followed by a reason, on the line or in the comment just above it,
        // marks a pause that is not a readiness wait at all — an observation
        // window, say — and makes every other one a thing somebody has to
        // argue for in a diff.
        const saidWhy = lines.slice(Math.max(0, index - 12), index + 1)
          .some((near) => /journeys:duration-ok\s+\S/.test(near));
        if (saidWhy) return;
        hits.push(`drivers/${name}:${index + 1}: ${line.trim()}`);
      });
    }
    expect(
      hits,
      'a duration is a guess about how fast the machine is, and every one of them in this '
      + 'driver has eventually produced a red CI job on somebody else\'s branch',
    ).toEqual([]);
  });

  test('no readiness assertion is built on a hasText string', () => {
    // **This is the check that catches the bug the other two do not.** An
    // independent review put `activateRoutine` back to its exact pre-fix shape
    // — the vacuous `hasText: 'Active'` wait restored — and both guards above
    // passed, because guard 2 is positional: it asks only whether a
    // settle-shaped token comes before the first read-shaped token, and an
    // `expect(...)` around a locator that matches the state it is waiting to
    // leave is still such a token.
    //
    // So this one is about the *content* of the wait. Playwright's `hasText`
    // string form is a case-insensitive substring, which is right for picking
    // a row out of a table by its name and wrong for every assertion of the
    // form "wait until the screen says X": "Inactive" contains "active", and
    // that one fact cost five red CI jobs. Inside an `expect(...)` the string
    // form is never what the author meant — `toHaveText('Active')` compares
    // the whole text, and a regular expression says out loud that it is a
    // pattern. There are no such sites now; before this branch there were two,
    // one of them the bug.
    const hits: string[] = [];
    for (const name of fs.readdirSync(DRIVERS).filter((f) => f.endsWith('.ts'))) {
      const source = fs.readFileSync(path.join(DRIVERS, name), 'utf8');
      for (let at = source.indexOf('expect('); at >= 0; at = source.indexOf('expect(', at + 1)) {
        // The whole `expect(…)` call, found by balancing its parentheses, so a
        // wait written over three lines is examined as one thing.
        let depth = 0;
        let end = at + 'expect'.length;
        for (; end < source.length; end += 1) {
          if (source[end] === '(') depth += 1;
          else if (source[end] === ')') { depth -= 1; if (depth === 0) { end += 1; break; } }
        }
        const call = source.slice(at, end);
        if (!/hasText:\s*['"`]/.test(call)) continue;
        hits.push(`drivers/${name}:${source.slice(0, at).split('\n').length}: `
          + call.replace(/\s+/g, ' ').slice(0, 120));
      }
    }
    expect(
      hits,
      "`hasText: '…'` is a case-insensitive substring, so a wait built on it can be satisfied by "
      + 'the very state it is waiting to leave. Use toHaveText for a whole-text comparison, or a '
      + 'regular expression if a pattern is really what is meant',
    ).toEqual([]);
  });

  test('every driver method waits for something before its first screen read', () => {
    const source = fs.readFileSync(path.join(DRIVERS, 'classic.ts'), 'utf8');
    const methods = driverMethods(source);
    expect(methods.length, 'the driver method scan found nothing, so this guard proves nothing')
      .toBeGreaterThan(100);
    const hits: string[] = [];
    for (const { name, body } of methods) {
      if (name in UNSETTLED_FIRST_READ_IS_SOUND) continue;
      const firstRead = body.findIndex((l) => SCREEN_READS.some((r) => code(l).includes(r)));
      if (firstRead < 0) continue;
      const firstSettle = body.findIndex((l) => SETTLES.test(code(l)));
      if (firstSettle < 0 || firstSettle > firstRead) {
        hits.push(`${name}: ${body[firstRead].trim()}`);
      }
    }
    expect(
      hits,
      'a driver method reads the screen before it has waited for anything — which is how a read '
      + 'measures the state before the write that produced it, and reports it as a fact',
    ).toEqual([]);
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
