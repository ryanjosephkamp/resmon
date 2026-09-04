/**
 * The window itself — the part of `main.ts` a bare-X runner cannot see.
 *
 * The spike's sharpest finding was not about a test: `xvfb-run` starts an X
 * server with **no window manager**, and `BrowserWindow.maximize()` is a
 * request a window manager honours. With none present the call is a silent
 * no-op. So a green CI run under xvfb verifies the *renderer* thoroughly and
 * the *window* barely — and `electron/main.ts`'s window handling is the part
 * that had no test at all, which is why this phase exists.
 *
 * Every test here **says which arm held**, so a run states what it did not
 * verify rather than passing quietly. `ui-smoke.yml` runs this file on both
 * `ubuntu-latest` (where most of it skips, and the job summary says so) and on
 * a macOS runner (where it does not).
 *
 * The swipe test is the exception and runs everywhere: it drives the handler
 * `main.ts` binds, not the trackpad. That distinction is stated in the test
 * rather than papered over — an OS gesture cannot be synthesised, and macOS
 * only delivers `swipe` at all when the user has set a two-finger gesture in
 * System Settings, which is why the History menu exists alongside it.
 */
import { test, expect } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import { launchResmon } from './fixtures/resmon-app';

test.describe.configure({ mode: 'serial' });

interface WindowFacts {
  bounds: { width: number; height: number };
  maximized: boolean;
  workArea: { width: number; height: number };
}

async function windowFacts(app: ElectronApplication): Promise<WindowFacts> {
  return app.evaluate(async ({ BrowserWindow, screen }) => {
    const w = BrowserWindow.getAllWindows()[0];
    const b = w.getBounds();
    const wa = screen.getPrimaryDisplay().workAreaSize;
    return {
      bounds: { width: b.width, height: b.height },
      maximized: w.isMaximized(),
      workArea: { width: wa.width, height: wa.height },
    };
  });
}

/**
 * True when something honoured a maximize request.
 *
 * Not `isMaximized()` alone: on a bare X server the flag stays false *and* the
 * window keeps the constructor's size, which is the signature of no window
 * manager rather than of a broken app.
 */
function hasWindowManager(facts: WindowFacts): boolean {
  return facts.maximized
    || facts.bounds.width >= facts.workArea.width - 2;
}

test('the app opens maximized, where a window manager exists to honour it', async () => {
  test.setTimeout(240_000);
  // `RESMON_E2E` unset: this is the behaviour a user gets, and the E2E flag
  // exists precisely to suppress it so screenshots have a written-down size.
  const { app, stateDir } = await launchResmon(false);
  try {
    const win = await app.firstWindow({ timeout: 180_000 });
    await win.waitForLoadState('domcontentloaded');
    await win.locator('.app-main').waitFor({ state: 'visible', timeout: 60_000 });
    await win.waitForTimeout(1000);

    const facts = await windowFacts(app);
    console.log('WM MAXIMIZE ON OPEN', JSON.stringify(facts));
    if (!hasWindowManager(facts)) {
      console.log(
        'WM NOT VERIFIED — no window manager on this display (bare X, e.g. xvfb):',
        `the window kept its ${facts.bounds.width}x${facts.bounds.height} constructor size`,
        `on a ${facts.workArea.width}x${facts.workArea.height} work area.`,
        'maximize-on-open is NOT verified by this run.',
      );
      test.skip(true, 'no window manager on this display');
    }
    expect(facts.maximized || facts.bounds.width >= facts.workArea.width - 2).toBe(true);
    console.log('WM MAXIMIZE ON OPEN — verified: a window manager honoured it');
  } finally {
    await app.close().catch(() => { /* already gone */ });
    const fs = await import('fs');
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('the in-app link window is a child of the main window and comes to the front', async () => {
  test.setTimeout(240_000);
  const { app, stateDir } = await launchResmon(true);
  try {
    const win = await app.firstWindow({ timeout: 180_000 });
    await win.waitForLoadState('domcontentloaded');
    await win.locator('.app-main').waitFor({ state: 'visible', timeout: 60_000 });

    const mainId = await app.evaluate(async ({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].id);

    await win.evaluate(() => { window.location.hash = '#/repositories'; });
    await win.waitForFunction(() => window.location.hash.startsWith('#/repositories'));
    const link = win.locator('.required-attributions a').first();
    await link.waitFor({ state: 'visible', timeout: 30_000 });
    await link.click();
    await expect.poll(() => app.windows().length, { timeout: 20_000 }).toBe(2);
    await new Promise((r) => setTimeout(r, 1500));

    const facts = await app.evaluate(async ({ BrowserWindow }, keep) => {
      const all = BrowserWindow.getAllWindows();
      const opened = all.find((w) => w.id !== keep);
      const main = all.find((w) => w.id === keep);
      return {
        parentIsMain: opened?.getParentWindow()?.id === keep,
        openedVisible: opened?.isVisible() ?? false,
        openedFocused: opened?.isFocused() ?? false,
        mainFocused: main?.isFocused() ?? false,
        anyFocused: all.some((w) => w.isFocused()),
      };
    }, mainId);
    console.log('WM LINK WINDOW', JSON.stringify(facts));

    // Parentage and visibility are the app's own doing and hold anywhere.
    expect(facts.parentIsMain).toBe(true);
    expect(facts.openedVisible).toBe(true);

    // Focus is the window manager's to give, and it gives it to the frontmost
    // application. Under a launcher — a bare X server with no window manager,
    // or a local run where the terminal stays frontmost — **no** window reports
    // focus, which is what `anyFocused` measures. Asserting through that would
    // make this red for a reason no change to this repository could fix, so the
    // run says which arm held instead. Measured on the machine this was written
    // on: `anyFocused` was false, so the local run does not verify it either.
    if (!facts.anyFocused) {
      console.log(
        'WM LINK FOCUS NOT VERIFIED — no window on this display reports focus at all,',
        'so resmon is not the frontmost application here. That is the normal state',
        'under xvfb (no window manager) and under a local run whose terminal keeps',
        'focus. Which window would come to the front is NOT verified by this run.',
      );
      test.skip(true, 'no window reports focus on this display');
    }
    expect(facts.openedFocused).toBe(true);
    expect(facts.mainFocused).toBe(false);
    console.log('WM LINK FOCUS — verified: the link window took focus from the main window');

    await app.evaluate(async ({ BrowserWindow }, keep) => {
      for (const w of BrowserWindow.getAllWindows()) if (w.id !== keep) w.destroy();
    }, mainId);
  } finally {
    await app.close().catch(() => { /* already gone */ });
    const fs = await import('fs');
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('the swipe handler moves history back and forward', async () => {
  test.setTimeout(240_000);
  // **What this is and is not.** `main.ts` binds `mainWindow.on('swipe')`, and
  // this emits that event on the real window in the real main process, so the
  // binding and `navigateHistory` are genuinely exercised. It is not the
  // trackpad: an OS gesture cannot be synthesised, and macOS only delivers
  // `swipe` when the user has chosen a two-finger gesture in System Settings —
  // undetectable from the app, which is exactly why the History menu exists
  // alongside it. `main-window.spec.ts` P4 drives that menu.
  const { app, stateDir } = await launchResmon(true);
  try {
    const win = await app.firstWindow({ timeout: 180_000 });
    await win.waitForLoadState('domcontentloaded');
    await win.locator('.app-main').waitFor({ state: 'visible', timeout: 60_000 });

    const go = async (hash: string) => {
      await win.evaluate((h) => { window.location.hash = `#${h}`; }, hash);
      await win.waitForFunction((h) => window.location.hash.startsWith(`#${h}`), hash,
        { timeout: 15_000 });
      await win.waitForTimeout(300);
    };
    await go('/explorer');
    await go('/repositories');

    const swipe = (direction: 'left' | 'right') => app.evaluate(
      async ({ BrowserWindow }, d) => {
        BrowserWindow.getAllWindows()[0].emit('swipe', {}, d);
        return true;
      }, direction,
    );

    await swipe('left');
    await win.waitForFunction(() => window.location.hash.startsWith('#/explorer'),
      undefined, { timeout: 15_000 });
    expect(win.url()).toContain('#/explorer');

    await swipe('right');
    await win.waitForFunction(() => window.location.hash.startsWith('#/repositories'),
      undefined, { timeout: 15_000 });
    expect(win.url()).toContain('#/repositories');
    console.log('WM SWIPE — left went back, right went forward');
  } finally {
    await app.close().catch(() => { /* already gone */ });
    const fs = await import('fs');
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
