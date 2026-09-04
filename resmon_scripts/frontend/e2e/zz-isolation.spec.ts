/**
 * The suite leaves nothing behind — P12 and P14.
 *
 * **Named `zz-` on purpose.** Playwright runs spec files in path order, and
 * these two checks are about the state of the machine *after* everything else
 * has run: the screenshots are written, the temp state directories are made and
 * removed, and every launch has come and gone. A file named `isolation` would
 * sort fourth and measure a run that had barely started.
 *
 * **P12 — the developer's own resmon is not the test subject.** This was found
 * the hard way by the spike: `RESMON_STATE_DIR` isolates the *backend's* state
 * — database, reports, daemon lock — and does nothing about Chromium's own
 * profile, which `app.getPath('userData')` puts in the real
 * `~/Library/Application Support/resmon`, the directory the installed app uses.
 * The first run of the launch fixture inherited a persisted 1.2 zoom factor
 * from somebody's real session, and was writing into that profile as it went. A
 * screenshot taken at an inherited zoom is not evidence of anything.
 *
 * **P14 — a run leaves the working tree clean.** 18 screenshots used to be
 * committed and every stacked branch conflicted on them, because two branches
 * that both run the suite both rewrite every file. A committed screenshot is a
 * merge conflict, not evidence.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test, expect } from './fixtures/resmon-app';
import { FRONTEND_ROOT, REPO_ROOT, SCREENSHOT_DIR } from './fixtures/resmon-app';

const E2E_DIR = path.join(FRONTEND_ROOT, 'e2e');

/** Where the *installed* app keeps its Chromium profile on this platform. */
function realUserDataDir(): string {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'resmon');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'resmon');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'resmon');
}

/** path → size + mtime, for every file under a directory. Read-only. */
function manifest(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(dir)) return out;
  const walk = (d: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return; // unreadable is not this test's business
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      try {
        const st = fs.statSync(full);
        out[path.relative(dir, full)] = `${st.size}:${st.mtimeMs}`;
      } catch { /* vanished mid-walk */ }
    }
  };
  walk(dir);
  return out;
}

test('P12: a launch uses its own Chromium profile, not the installed app\'s', async ({
  app, win,
}) => {
  // `win` is depended on so a window exists to read a zoom factor from — the
  // worker-scoped app fixture resolves before `firstWindow()` has been awaited.
  await win.waitForLoadState('domcontentloaded');
  const userData = await app.evaluate(async ({ app: a }) => a.getPath('userData'));
  const real = realUserDataDir();
  console.log('P12 USER DATA', JSON.stringify({ underTest: userData, installed: real }));

  // Not the real one …
  expect(path.resolve(userData)).not.toBe(path.resolve(real));
  // … and inside a temp directory this run created.
  expect(path.resolve(userData).startsWith(path.resolve(os.tmpdir()))
    || path.resolve(userData).startsWith('/private/var/folders')).toBe(true);
  expect(path.basename(userData)).toBe('electron-user-data');

  // And the zoom is 1, which is the thing the inherited profile got wrong.
  const zoom = await app.evaluate(async ({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.getZoomFactor());
  expect(zoom).toBe(1);
});

test('P12b: every file that launches the app passes --user-data-dir', () => {
  // A runtime check covers the launches that ran; this covers the ones that
  // did not, including a spec added later. `--user-data-dir` is a Chromium
  // switch handled before any app code, so it cannot be asserted from inside
  // the app for a launch that never happened.
  //
  // Scoped to the **file** rather than the call site, and the first version of
  // this was scoped to the call site and produced a false positive:
  // `zero-reasons.spec.ts` builds its `args` array in a variable a few lines
  // above the call, which is perfectly correct and invisible to a regex over
  // the call. What that costs is stated in the handback: a launch whose args
  // came from *another module* would pass this.
  const files = fs.readdirSync(E2E_DIR, { recursive: true, encoding: 'utf8' } as never) as
    unknown as string[];
  const sources = files
    .filter((f) => typeof f === 'string' && f.endsWith('.ts'))
    .map((f) => path.join(E2E_DIR, f))
    .filter((f) => fs.statSync(f).isFile());

  const offenders: string[] = [];
  let launches = 0;
  for (const file of sources) {
    const text = fs.readFileSync(file, 'utf8');
    const calls = [...text.matchAll(/electron\.launch\(/g)].length;
    if (calls === 0) continue;
    launches += calls;
    if (!text.includes('--user-data-dir')) offenders.push(path.basename(file));
  }
  console.log('P12b LAUNCH SITES', JSON.stringify({ launches, offenders }));
  expect(launches).toBeGreaterThan(0);
  expect(offenders).toEqual([]);
});

test('P12c: the installed app\'s profile is byte-for-byte unchanged by a launch', async () => {
  test.setTimeout(300_000);
  const real = realUserDataDir();
  const before = manifest(real);
  if (Object.keys(before).length === 0) {
    // Nothing to protect on this machine — a CI runner has never installed
    // resmon. Say so rather than reporting a vacuous pass.
    console.log(
      'P12c NOT VERIFIED — there is no installed-app profile at', real,
      'on this machine, so a launch has nothing to disturb. The property holds',
      'vacuously here; it was measured on a machine that has one.',
    );
    test.skip(true, `no installed profile at ${real}`);
  }

  const { launchResmon } = await import('./fixtures/resmon-app');
  const { app, stateDir } = await launchResmon(true);
  try {
    const win = await app.firstWindow({ timeout: 180_000 });
    await win.waitForLoadState('domcontentloaded');
    await win.locator('.app-main').waitFor({ state: 'visible', timeout: 60_000 });
    // Do the things that write to a profile: navigate, and change the zoom.
    for (const hash of ['/', '/settings/ai', '/repositories']) {
      await win.evaluate((h) => { window.location.hash = `#${h}`; }, hash);
      await win.waitForTimeout(300);
    }
    await app.evaluate(async ({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.4);
    });
    await win.waitForTimeout(500);
  } finally {
    await app.close().catch(() => { /* already gone */ });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }

  const after = manifest(real);
  const changed = Object.keys({ ...before, ...after })
    .filter((k) => before[k] !== after[k]);
  console.log('P12c INSTALLED PROFILE', JSON.stringify({
    dir: real, files: Object.keys(before).length, changed,
  }));
  expect(changed, `the launch touched the installed app's profile:\n${
    JSON.stringify(changed, null, 2)}`).toEqual([]);
});

test('P14: a full run leaves no modified or untracked file under e2e/', () => {
  // Runs last (see the file header), so the screenshots this asserts about
  // have already been written by every other spec.
  const shots = fs.existsSync(SCREENSHOT_DIR)
    ? fs.readdirSync(SCREENSHOT_DIR).filter((f) => f.endsWith('.png'))
    : [];
  console.log('P14 SCREENSHOTS WRITTEN', shots.length, 'to', SCREENSHOT_DIR);
  expect(shots.length).toBeGreaterThan(0);

  const status = execFileSync('git', ['status', '--porcelain', '--', 'resmon_scripts/frontend/e2e'],
    { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n').filter(Boolean);
  console.log('P14 GIT STATUS UNDER e2e/', JSON.stringify(status));

  // What a *run* can leave behind: a modified tracked file, or an untracked
  // artefact — a screenshot, a trace, an image. A hand-added spec file that is
  // not committed yet is not something the run did, and failing on it would
  // make this red for every work in progress.
  const leftBehind = status.filter((line) => {
    const state = line.slice(0, 2);
    const file = line.slice(3);
    if (state.includes('M') || state.includes('D')) return true;
    return /(^|\/)e2e\/(screenshots|test-results)\//.test(`/${file}`)
      || /\.(png|jpe?g|gif|webp|zip|webm)$/.test(file);
  });
  expect(
    leftBehind,
    'a run must leave the working tree as it found it — screenshots are gitignored '
    + 'and `npm run e2e:review` writes outside the repository entirely',
  ).toEqual([]);

  // And nothing under e2e/ is tracked as an image any more.
  const tracked = execFileSync('git', ['ls-files', 'resmon_scripts/frontend/e2e'],
    { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n').filter((f) => /\.(png|jpe?g|gif|webp)$/.test(f));
  console.log('P14 TRACKED IMAGES UNDER e2e/', JSON.stringify(tracked));
  expect(tracked).toEqual([]);
});
