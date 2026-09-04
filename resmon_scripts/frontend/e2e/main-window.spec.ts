/**
 * `electron/main.ts`, under test for the first time.
 *
 * 709 lines, every v1.8.3 interface fix, and — until this file — **no test of
 * any kind**. `tsconfig.electron.json` excludes `src`, `jest.config.js` roots
 * only at `src`, and nothing in CI had ever started the app. The only automated
 * check was `tsc`, which cannot tell a window painted the right colour from one
 * painted white.
 *
 * These are the three properties that only a real browser engine can see. Each
 * one is a fix a human found by looking at the app, and each would be silently
 * undone by an ordinary refactor with the whole suite green:
 *
 * - **P2** the window's own background matches the stylesheet's (the white
 *   flash on open and close, v1.8.3);
 * - **P3** an external link opens *in-app*, with the URL in the title bar, and
 *   never hands http(s) to the system browser (link behaviour used to depend on
 *   where you clicked: attribution links opened in-app, repository detail links
 *   threw you out to Safari);
 * - **P4** the History menu moves the hash route (back and forward had never
 *   been wired to a history the app always kept).
 */
import { test, expect } from './fixtures/resmon-app';
import { installIpcGuards, readGuards, NOTHING_ESCAPED } from './fixtures/ipc-guards';
import * as fs from 'fs';
import * as path from 'path';
import { FRONTEND_ROOT } from './fixtures/resmon-app';

test.describe.configure({ mode: 'serial' });

/** `#0F1117`, `#ff0f1117`, `#0f1117` → `0f1117`. Electron and CSS disagree on case and alpha. */
function rgbHex(value: string): string {
  const hex = value.trim().replace(/^#/, '').toLowerCase();
  // Electron returns ARGB or RGBA on some platforms; the colour is the last six.
  return hex.length === 8 ? hex.slice(-6) : hex;
}

test('P2: the window background is the stylesheet background', async ({ app, win, goto }) => {
  await goto('/');

  // The main process's own value — what Chromium composites *before the
  // renderer has painted anything*, which is the whole point. A body rule
  // cannot fix a white flash; it has not run yet.
  const windowBg = await app.evaluate(async ({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getBackgroundColor());

  // The stylesheet's value, resolved by the real engine rather than read out of
  // the file, so a variable that is overridden further down the cascade is
  // caught too.
  const cssVar = await win.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--color-bg'));
  const bodyBg = await win.evaluate(() => getComputedStyle(document.body).backgroundColor);

  console.log('P2 BACKGROUND', JSON.stringify({ windowBg, cssVar, bodyBg }));
  expect(rgbHex(windowBg)).toBe(rgbHex(cssVar));

  // And the painted body agrees with both, so the two halves of the fix cannot
  // drift apart in either direction. `rgb(15, 17, 23)` is `#0f1117`.
  const [r, g, b] = (bodyBg.match(/\d+/g) ?? []).map(Number);
  const painted = [r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('');
  expect(painted).toBe(rgbHex(cssVar));
});

test('P3: an external link opens in-app, titled with its URL, and never reaches the browser', async ({
  app, win, goto,
}) => {
  await installIpcGuards(app);
  await goto('/repositories');

  // A real link on a real page: the "terms" link beside a required attribution
  // credit. Those render unconditionally (a credit behind a disclosure is not
  // displayed in the sense the licence means), so this is a user path and not a
  // fixture.
  const link = win.locator('.required-attributions a').first();
  await expect(link).toBeVisible();
  const href = await link.getAttribute('href');
  expect(href).toMatch(/^https?:\/\//);

  // `getAllWindows()` is not in creation order — the first run of this spec
  // found the freshly opened link window at index 0 and the main window at
  // index 1 — so the main window is identified by id before the click rather
  // than by position after it.
  const mainId = await app.evaluate(async ({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].id);
  const before = app.windows().length;
  await link.click();

  // `setWindowOpenHandler` runs in the main process, so the new window is an
  // Electron fact rather than a DOM one.
  await expect.poll(() => app.windows().length, { timeout: 20_000 }).toBe(before + 1);

  const windows = await app.evaluate(async ({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((w) => ({
      id: w.id,
      title: w.getTitle(),
      background: w.getBackgroundColor(),
    })));
  console.log('P3 WINDOWS', JSON.stringify(windows));
  const main = windows.find((w) => w.id === mainId);
  const opened = windows.find((w) => w.id !== mainId);
  expect(main).toBeTruthy();
  expect(opened).toBeTruthy();

  // The title bar carries the address. That is the whole reason this window
  // exists rather than a plain popup: a licence page that sets its own title
  // would otherwise hide where you are, and `page-title-updated` is prevented
  // in `openLinkWindow` for exactly that reason.
  expect((opened as { title: string }).title).toBe(href);
  // Same background as the main window — the flash fix applies here too.
  expect(rgbHex((opened as { background: string }).background))
    .toBe(rgbHex((main as { background: string }).background));

  // And nothing was handed to the system browser. This is the assertion the
  // v1.8.3 fix exists for, and it is a count rather than an inference.
  const guards = await readGuards(app);
  console.log('P3 GUARD COUNTS', JSON.stringify(guards.escaped));
  expect(guards.escaped).toEqual(NOTHING_ESCAPED);

  // Leave the app as it was found — a stray window would confuse every spec
  // after this one about which window is which.
  await app.evaluate(async ({ BrowserWindow }, keep) => {
    for (const w of BrowserWindow.getAllWindows()) if (w.id !== keep) w.destroy();
  }, mainId);
  await expect.poll(() => app.windows().length, { timeout: 10_000 }).toBe(before);
});

test('P3b: the OS-facing surface of main.ts is still the five that are guarded', async () => {
  // The guards are only a measurement while they cover everything. A new
  // `shell.` or `dialog.` call in `main.ts` would escape silently, and the
  // count would still read zero.
  const source = fs.readFileSync(path.join(FRONTEND_ROOT, 'electron', 'main.ts'), 'utf8')
    // Comments first. `main.ts` explains `shell.openExternal` in prose in three
    // places, and a call that exists only in a comment is not a call — this
    // check has to be able to go red, so it must not be satisfied by the file
    // *talking about* a function.
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  // `void dialog\n  .showMessageBox({` is real code in this file, so the dot
  // may carry a line break with it.
  const calls = new Set(
    [...source.matchAll(/\b(?:dialog|shell)\s*\.\s*(\w+)\s*\(/g)].map((m) => m[1]),
  );
  console.log('P3b OS-FACING CALLS IN main.ts', JSON.stringify([...calls].sort()));
  expect([...calls].sort()).toEqual([
    'openExternal', 'openPath', 'showItemInFolder', 'showMessageBox', 'showOpenDialog',
  ]);
});

test('P4: the History menu moves the hash route', async ({ app, win, goto }) => {
  await goto('/analytics');
  await goto('/watchdog');
  expect(win.url()).toContain('#/watchdog');

  /** Click a real application-menu item, by id, in the real main process. */
  const clickMenu = (id: string) => app.evaluate(async ({ Menu }, itemId) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(itemId);
    if (!item) throw new Error(`no menu item ${itemId}`);
    item.click();
    return true;
  }, id);

  await clickMenu('history-back');
  await win.waitForFunction(() => window.location.hash.startsWith('#/analytics'),
    undefined, { timeout: 15_000 });
  expect(win.url()).toContain('#/analytics');

  await clickMenu('history-forward');
  await win.waitForFunction(() => window.location.hash.startsWith('#/watchdog'),
    undefined, { timeout: 15_000 });
  expect(win.url()).toContain('#/watchdog');
  console.log('P4 HISTORY', JSON.stringify({ final: win.url().split('#')[1] }));
});
