/**
 * P6 — the app behaves the same with `RESMON_E2E` unset.
 *
 * A diff of the code shows three `isE2E()` branches; it does not show that the
 * unset path still does what it did. This launches the same app twice, with
 * environments differing in **nothing but** `RESMON_E2E` (`launchEnv()` in the
 * fixture builds both, so the two cannot drift), and compares the behaviour
 * each branch controls:
 *
 *   - hunk 1+2, the window: unset ⇒ maximized, the size of the display's work
 *     area, `isMaximized()` true. Set ⇒ exactly the requested 1440x900 and
 *     `isMaximized()` false.
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

test('P6: RESMON_E2E unset keeps the maximized window; set gives a fixed one', async () => {
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

  // The pre-flag behaviour, unchanged.
  expect(plainObs.maximized).toBe(true);
  expect(plainObs.bounds.width).toBe(plainObs.workArea.width);
  expect(plainObs.bounds.height).toBe(plainObs.workArea.height);

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
