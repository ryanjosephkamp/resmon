/**
 * The guards that make the rest of this directory a denominator.
 *
 * Six things are checked here and all six fail the run rather than logging.
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
 * 4. **Every screen the app has names the rows that carry it.** The first
 *    three compare the register with this directory; this one compares it
 *    with the app (`atlas/src/screenPaths.ts`), which nothing did until the
 *    Source wall had been a page with no row for nine days.
 * 5. **A driver waits for a state, never for a duration**, and never reads the
 *    screen before it has waited for something.
 * 6. **The candidate takes a person's setup through Atlas's screen.** It
 *    borrows from the screenless driver only what `drivers/borrowed.ts` lists:
 *    what has no screen, and setup Atlas has no screen for yet, each entry
 *    with its reason, and none that Atlas now implements.
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
import { API_SETUP, SCREENLESS } from './drivers/borrowed';
import { SCREEN_PATHS } from '../atlas/src/screenPaths';

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
    expect(JOURNEY_REGISTER.length, 'the parity register has 49 journeys').toBe(49);
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
  test('every screen the app has names the rows that carry it', () => {
    // Every screen at a fixed address, Settings' groups included, from the list
    // `atlas/src/__tests__/screenPaths.test.ts` holds to the router.
    const hashes = SCREEN_PATHS.map((screen) => screen.path);
    const unmapped = hashes.filter((hash) => !(hash in ROUTE_ROWS));
    expect(
      unmapped,
      'a screen the app has no register row — add a row and its spec, or say in '
      + 'ROUTE_ROWS which existing row carries what a person does there',
    ).toEqual([]);
    const stale = Object.keys(ROUTE_ROWS).filter((hash) => !hashes.includes(hash));
    expect(stale, 'ROUTE_ROWS names a screen the app no longer has').toEqual([]);
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
 * `goto` or one of the driver's `open…` helpers (each waits for its screen's
 * own landmark), or `stored`, the driver's own "the app has recorded it"
 * predicate.
 */
const SETTLES = /expect\s*\(|expect\.poll|waitForResponse|waitForFunction|\.waitFor\(|waitForLoadState|\bstored\(|\bgoto\(|\bopen[A-Z]\w*\(/;

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
  addToTheEvidenceProject: 'getAttribute waits for Add files to be attached, and reads whether it is pressed only to decide whether to press it; the chooser it opens is waited for',
  readSidebarPlaces: 'its reads are in a helper defined first and called only after goto has arrived at each place',
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
    const source = fs.readFileSync(path.join(DRIVERS, 'atlas.ts'), 'utf8');
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
 * Setup a person does on a screen goes through Atlas's screen.
 *
 * The candidate drives Atlas and borrows from the screenless driver only what
 * `drivers/borrowed.ts` lists: members that touch no screen, and setup steps
 * Atlas has no screen for yet, each with the reason. Before
 * this guard the borrowed list mixed the two, and a journey whose setup was
 * borrowed passed whether or not Atlas could take the step: Atlas shipped
 * without Settings › AI › Embeddings while J09 and J11 passed. So the lists
 * are held to four things, all read from the files rather than from a running
 * driver, because this guard launches nothing:
 *
 * 1. Nothing is borrowed except through the two lists, and each name in them
 *    is a member of the driver that the screenless driver implements.
 * 2. Each API-setup entry says, as a fact, which Atlas screen is missing and
 *    which route the screenless driver takes instead.
 * 3. No entry outlives the Atlas screen: once `atlas.ts` implements a member,
 *    the candidate takes that step through Atlas, and the entry has to go.
 * 4. A screenless member writes nothing to the app in its own body. That is
 *    the check that keeps a setup step from being filed as screenless to skip
 *    giving a reason. It reads the member's own body, not the helpers it
 *    calls, and `backend` is the engine's record by definition.
 */
const DRIVER = path.join(HERE, 'driver.ts');

/** Every member the `JourneyDriver` interface declares, across each of its declarations. */
function journeyDriverMembers(): Set<string> {
  const lines = fs.readFileSync(DRIVER, 'utf8').split('\n');
  const members = new Set<string>();
  let inside = false;
  for (const line of lines) {
    if (/^export interface JourneyDriver\b/.test(line)) { inside = true; continue; }
    if (inside && /^}/.test(line)) { inside = false; continue; }
    const match = inside ? /^ {2}(?:readonly )?([A-Za-z_][A-Za-z0-9_]*)\??[(:<]/.exec(line) : null;
    if (match) members.add(match[1]);
  }
  return members;
}

/**
 * What `screenless.ts` implements, from its `ScreenlessDriver` type, which
 * TypeScript holds to the object it returns, and each member's body.
 */
function screenlessMembers(): { names: Set<string>; bodies: Map<string, string[]> } {
  const source = fs.readFileSync(path.join(DRIVERS, 'screenless.ts'), 'utf8');
  const declared = /export type ScreenlessDriver = Pick<JourneyDriver,([\s\S]*?)>;/.exec(source);
  expect(declared, 'screenless.ts no longer declares the ScreenlessDriver type this guard reads').toBeTruthy();
  const names = new Set([...declared![1].matchAll(/'([A-Za-z_][A-Za-z0-9_]*)'/g)].map((m) => m[1]));
  const methods = driverMethods(source).filter((m) => names.has(m.name));
  return { names, bodies: new Map(methods.map((m) => [m.name, m.body])) };
}

/** What `atlas.ts` implements: its `AtlasDriver` type, which TypeScript holds to the object it returns. */
function atlasMembers(): Set<string> {
  const source = fs.readFileSync(path.join(DRIVERS, 'atlas.ts'), 'utf8');
  const declared = /export type AtlasDriver = Pick<JourneyDriver,([\s\S]*?)>;/.exec(source);
  expect(declared, 'atlas.ts no longer declares the AtlasDriver type this guard reads').toBeTruthy();
  return new Set([...declared![1].matchAll(/'([A-Za-z_][A-Za-z0-9_]*)'/g)].map((m) => m[1]));
}

/** A write to the app's API, in any of the shapes the drivers make one. */
const API_WRITE = /\bapi(?:<[^>]*>)?\(\s*['"](?:POST|PUT|PATCH|DELETE)['"]|\bmethod:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/;

test.describe('the candidate borrows from the screenless driver only what Atlas has no screen for', () => {
  const setup = Object.keys(API_SETUP);

  test('nothing is borrowed except through the two lists, and each name is a screenless member', () => {
    const declared = journeyDriverMembers();
    expect(declared.size, 'the JourneyDriver scan found nothing, so this guard proves nothing').toBeGreaterThan(100);
    const screenless = screenlessMembers().names;
    expect(screenless.size, 'the ScreenlessDriver scan found nothing, so this guard proves nothing').toBeGreaterThan(10);
    const problems: string[] = [];
    for (const name of SCREENLESS.filter((n) => setup.includes(n))) problems.push(`${name} is in both lists`);
    for (const name of [...SCREENLESS, ...setup]) {
      if (!declared.has(name)) problems.push(`${name} is not a member of JourneyDriver`);
      else if (!screenless.has(name)) problems.push(`${name} is not implemented by the screenless driver`);
    }
    // The candidate itself: every read of the screenless driver's members goes
    // through `borrowed`, and the one member it hands Atlas by name is
    // screenless.
    const candidate = fs.readFileSync(path.join(DRIVERS, 'candidate.ts'), 'utf8').split('\n').map(code);
    candidate.forEach((line, index) => {
      if (/\b(?:shared|screenless)\s*\[/.test(line) && !line.includes('borrowed(')) {
        problems.push(`candidate.ts:${index + 1} reads the screenless driver outside borrowed: ${line.trim()}`);
      }
      for (const [, name] of line.matchAll(/\bscreenless\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
        if (!SCREENLESS.includes(name)) problems.push(`candidate.ts:${index + 1} hands Atlas screenless.${name}, which is not screenless`);
      }
    });
    expect(problems, 'a member reaches the candidate from the screenless driver without a list that says why').toEqual([]);
  });

  test('every API-setup entry says which Atlas screen is missing', () => {
    const reasons = Object.entries(API_SETUP);
    const problems: string[] = [];
    for (const [name, reason] of reasons) {
      const said = reason.trim();
      if (said.length < 60) problems.push(`${name}: "${said}" is too short to say which screen is missing and why`);
      if (!/\bAtlas\b/.test(said)) problems.push(`${name}: the reason never says what Atlas lacks`);
      if (!/\/api\//.test(said)) problems.push(`${name}: the reason never names the route the screenless driver takes`);
      if (/\b(?:TODO|TBD|FIXME|XXX)\b|not in Atlas yet|same as (?:above|screenless)/i.test(said)) {
        problems.push(`${name}: "${said}" is a placeholder, not a reason`);
      }
      if (reasons.some(([other, text]) => other !== name && text.trim() === said)) {
        problems.push(`${name}: the same reason is given for another member, so it says nothing about this one`);
      }
    }
    expect(problems, 'an API-setup entry does not say, as a fact, why no Atlas screen takes the step').toEqual([]);
  });

  test('no borrowed entry outlives the Atlas screen that now takes its step', () => {
    const atlas = atlasMembers();
    expect(atlas.size, 'the AtlasDriver scan found nothing, so this guard proves nothing').toBeGreaterThan(50);
    const outlived = setup.filter((name) => atlas.has(name))
      .map((name) => `${name}: atlas.ts implements it, so the API-setup entry is an exception with no screen missing`);
    const unreached = SCREENLESS.filter((name) => atlas.has(name))
      .map((name) => `${name}: atlas.ts implements it, so the candidate never borrows it`);
    expect([...outlived, ...unreached], 'a borrowed entry names a member Atlas now takes itself; remove it').toEqual([]);
  });

  test('a screenless member writes nothing to the app', () => {
    const { names, bodies } = screenlessMembers();
    const writes: string[] = [];
    for (const name of SCREENLESS) {
      const body = bodies.get(name);
      if (!body) {
        // A shorthand member carries no body here; `backend` is the only one
        // the screenless driver has, and it is the engine's record.
        if (name !== 'backend' || !names.has(name)) writes.push(`${name}: no body found to check`);
        continue;
      }
      if (API_WRITE.test(body.map(code).join('\n'))) writes.push(`${name} writes to the app's API`);
    }
    expect(
      writes,
      'a member filed as screenless writes to the app, which makes it setup: move it to API_SETUP with '
      + 'the reason no Atlas screen does it, or take the step through Atlas',
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
