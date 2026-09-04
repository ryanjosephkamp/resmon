/**
 * P6 — the app behaves the same with `RESMON_E2E` unset.
 *
 * A diff of the code shows three `isE2E()` branches; it does not show that the
 * unset path still does what it did. This launches the same app twice, with
 * environments differing in **nothing but** `RESMON_E2E` (`launchEnv()` in the
 * fixture builds both, so the two cannot drift), and compares the behaviour
 * each branch controls:
 *
 *   - hunk 1+2, the window: set ⇒ exactly the requested 1440x900, not
 *     maximized. Unset ⇒ the pre-flag size, which is the work area where a
 *     window manager exists and the constructor's 1280x820 where one does not.
 *     See the long comment at the assertion: `xvfb` has no window manager, so
 *     CI cannot verify the maximize itself.
 *   - hunk 3, the auto-updater: `initAutoUpdater` returns at `!app.isPackaged`
 *     before it ever reaches the `isE2E()` line, so in a checkout that hunk is
 *     unreachable and this spec cannot observe it. That is stated rather than
 *     asserted around — see `docs/ui-verification-feasibility.md`, Q7.
 *
 * Everything else in `main.ts` is untouched by the flag, and the two launches
 * agree on it: same renderer URL shape, same title, same preload bridge, same
 * spawn-its-own-backend decision.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import type { ElectronApplication } from '@playwright/test';
import { launchResmon, WINDOW_WIDTH, WINDOW_HEIGHT } from './fixtures/resmon-app';

interface Observed {
  bounds: { width: number; height: number };
  maximized: boolean;
  zoom: number;
  workArea: { width: number; height: number };
  title: string;
  url: string;
  hasBridge: boolean;
  backendPort: string;
  isPackaged: boolean;
}

async function observe(app: ElectronApplication): Promise<Observed> {
  const win = await app.firstWindow({ timeout: 180_000 });
  await win.waitForLoadState('domcontentloaded');
  // `ready-to-show` fires after the first paint; the maximize (or its absence)
  // has landed by the time the renderer has painted its shell.
  await win.locator('.app-main').waitFor({ state: 'visible', timeout: 30_000 });
  await win.waitForTimeout(500);

  const fromMain = await app.evaluate(async ({ BrowserWindow, screen, app: a }) => {
    const w = BrowserWindow.getAllWindows()[0];
    const b = w.getBounds();
    return {
      bounds: { width: b.width, height: b.height },
      maximized: w.isMaximized(),
      zoom: w.webContents.getZoomFactor(),
      workArea: {
        width: screen.getPrimaryDisplay().workAreaSize.width,
        height: screen.getPrimaryDisplay().workAreaSize.height,
      },
      title: w.getTitle(),
      isPackaged: a.isPackaged,
    };
  });

  const fromRenderer = await win.evaluate(() => ({
    url: window.location.href,
    hasBridge: typeof (window as unknown as { resmonAPI?: unknown }).resmonAPI === 'object',
    backendPort: (window as unknown as { resmonAPI: { getBackendPort(): string } })
      .resmonAPI.getBackendPort(),
  }));

  return { ...fromMain, ...fromRenderer };
}

test('P6: RESMON_E2E unset keeps the pre-flag window; set gives a fixed 1440x900 one', async () => {
  test.setTimeout(300_000);

  const plain = await launchResmon(false);
  let plainObs: Observed;
  try {
    plainObs = await observe(plain.app);
  } finally {
    await plain.app.close().catch(() => { /* already gone */ });
    fs.rmSync(plain.stateDir, { recursive: true, force: true });
  }

  const e2e = await launchResmon(true);
  let e2eObs: Observed;
  try {
    e2eObs = await observe(e2e.app);
  } finally {
    await e2e.app.close().catch(() => { /* already gone */ });
    fs.rmSync(e2e.stateDir, { recursive: true, force: true });
  }

  console.log('P6 RESMON_E2E UNSET', JSON.stringify(plainObs));
  console.log('P6 RESMON_E2E SET  ', JSON.stringify(e2eObs));

  // The pre-flag behaviour, unchanged — stated in the one way that is true on
  // both a desktop and a CI runner.
  //
  // `xvfb-run` starts a bare X server with **no window manager**, and
  // `BrowserWindow.maximize()` is a request a window manager honours. With
  // none, the call is a no-op: the first CI run of this spec came back
  // `{"bounds":{"width":1280,"height":820},"maximized":false,
  //   "workArea":{"width":1600,"height":1000}}` — the constructor's own size,
  // on a 1600x1000 virtual screen. That is not the app misbehaving and it is
  // not something a `RESMON_E2E` branch caused; it is what "maximize" means
  // with nothing there to do it.
  //
  // So the portable property is: **with the flag unset the app does not take
  // the E2E size**, and it takes whichever pre-flag size the display allows —
  // the work area where a window manager exists, the constructor's 1280x820
  // where one does not. Which arm held is logged, because the difference is
  // exactly the limitation 1.8.7 needs to know about: *the maximize-on-open
  // behaviour cannot be verified on a bare-X runner at all.*
  const DEFAULT_WIDTH = 1280;
  const DEFAULT_HEIGHT = 820;
  const maximizedAsRequested =
    plainObs.maximized
    && plainObs.bounds.width === plainObs.workArea.width
    && plainObs.bounds.height === plainObs.workArea.height;
  const leftAtConstructorSize =
    !plainObs.maximized
    && plainObs.bounds.width === DEFAULT_WIDTH
    && plainObs.bounds.height === DEFAULT_HEIGHT;

  console.log(
    'P6 UNSET WINDOW OUTCOME',
    maximizedAsRequested
      ? 'maximized to the work area (a window manager honoured it)'
      : leftAtConstructorSize
        ? 'left at the 1280x820 default (no window manager — bare X, e.g. xvfb); '
          + 'the maximize-on-open behaviour is NOT verified by this run'
        : 'neither — see the observations above',
  );

  expect(
    maximizedAsRequested || leftAtConstructorSize,
    `RESMON_E2E unset produced neither the maximized nor the ${DEFAULT_WIDTH}x${DEFAULT_HEIGHT} `
    + `default window: ${JSON.stringify(plainObs)}`,
  ).toBe(true);
  // Whatever it did, it did not take the size the flag asks for.
  expect(plainObs.bounds.width).not.toBe(WINDOW_WIDTH);

  // The flag's behaviour.
  expect(e2eObs.maximized).toBe(false);
  expect(e2eObs.bounds.width).toBe(WINDOW_WIDTH);
  expect(e2eObs.bounds.height).toBe(WINDOW_HEIGHT);

  // Everything the flag does not control is identical across the two launches.
  expect(plainObs.title).toBe(e2eObs.title);
  expect(plainObs.title).toBe('resmon');
  expect(plainObs.hasBridge).toBe(true);
  expect(e2eObs.hasBridge).toBe(true);
  expect(plainObs.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/index\.html/);
  expect(e2eObs.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/index\.html/);
  expect(plainObs.isPackaged).toBe(e2eObs.isPackaged);
  // Both spawned their own backend rather than attaching to the daemon.
  expect(plainObs.backendPort).not.toBe('8742');
  expect(e2eObs.backendPort).not.toBe('8742');
  // `--user-data-dir` is passed in both cases, so neither inherits a persisted
  // zoom from the user's profile.
  expect(plainObs.zoom).toBe(1);
  expect(e2eObs.zoom).toBe(1);
});
