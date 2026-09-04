/**
 * Q6, second half — does the **packaged** app launch under Playwright?
 *
 * The checkout runs `electron .` against loose files. An installer runs a
 * signed-or-not app bundle whose JavaScript is inside an asar, launched through
 * a platform-specific executable. Two things could differ and both matter:
 *
 *   1. **Electron fuses.** Playwright drives the main process over the Node
 *      inspector, so `EnableNodeCliInspectArguments` must be on. Electron Forge
 *      disables it in its default template; electron-builder does not flip
 *      fuses at all unless asked, and resmon's `build` block asks for nothing.
 *      Measured on the built app with `npx @electron/fuses read`, recorded in
 *      `docs/ui-verification-feasibility.md`.
 *   2. **The bundled backend.** A packaged app runs `Contents/Resources/backend`
 *      with its own interpreter and points its state at the per-user directory.
 *      `RESMON_STATE_DIR` still redirects that, and `RESMON_DB_PATH` /
 *      `RESMON_REPORTS_DIR` are honoured because `main.ts` sets them with `||`.
 *
 * The spec **skips rather than fails** when no packaged app is present, and the
 * skip reason names what is missing. Building one takes minutes and downloads a
 * Python runtime, so this cannot be a precondition of the smoke suite.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test, expect, _electron as electron } from '@playwright/test';
import { launchEnv, FRONTEND_ROOT, WINDOW_WIDTH } from './fixtures/resmon-app';
import { ROUTES } from './routes';

/** Where electron-builder leaves the app for each platform. */
function packagedExecutable(): string | null {
  const release = path.join(FRONTEND_ROOT, 'release');
  const candidates = process.platform === 'darwin'
    ? [
      path.join(release, 'mac-arm64', 'resmon.app', 'Contents', 'MacOS', 'resmon'),
      path.join(release, 'mac', 'resmon.app', 'Contents', 'MacOS', 'resmon'),
    ]
    : process.platform === 'win32'
      ? [path.join(release, 'win-unpacked', 'resmon.exe')]
      : [path.join(release, 'linux-unpacked', 'resmon')];
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

test('Q6: the packaged app launches under Playwright and serves every route', async () => {
  const exe = packagedExecutable();
  test.skip(
    exe === null,
    'no packaged app found under resmon_scripts/frontend/release — run `npm run dist` first',
  );
  test.setTimeout(300_000);

  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-pkg-'));
  const env = launchEnv(stateDir, true);
  // A packaged app carries its own interpreter under Contents/Resources/backend.
  // Leaving RESMON_PYTHON pointed at the checkout's venv would test the wrong
  // thing — the point is that the shipped bundle starts itself.
  delete env.RESMON_PYTHON;

  const app = await electron.launch({
    executablePath: exe as string,
    args: [`--user-data-dir=${path.join(stateDir, 'electron-user-data')}`],
    env,
    timeout: 180_000,
  });

  try {
    const info = await app.evaluate(async ({ app: a }) => ({
      isPackaged: a.isPackaged,
      version: a.getVersion(),
      electron: process.versions.electron,
      resources: process.resourcesPath,
    }));
    console.log('Q6 PACKAGED APP', JSON.stringify(info));
    // `electronApp.evaluate` returning at all is the fuse answer: the main
    // process accepted the Node inspector argument Playwright launched it with.
    expect(info.isPackaged).toBe(true);

    const win = await app.firstWindow({ timeout: 180_000 });
    await win.waitForLoadState('domcontentloaded');
    await win.locator('.app-main').waitFor({ state: 'visible', timeout: 120_000 });

    const port = await win.evaluate(
      () => (window as unknown as { resmonAPI: { getBackendPort(): string } })
        .resmonAPI.getBackendPort(),
    );
    console.log('Q6 PACKAGED BACKEND PORT', port);
    expect(port).not.toBe('8742');

    const bounds = await app.evaluate(async ({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getBounds());
    expect(bounds.width).toBe(WINDOW_WIDTH);

    // Every route, against the shipped bundle rather than the checkout.
    const empty: string[] = [];
    for (const route of ROUTES) {
      await win.evaluate((h) => { window.location.hash = `#${h}`; }, route.path);
      await win.waitForFunction((h) => window.location.hash.startsWith(`#${h}`), route.path,
        { timeout: 15_000 });
      await win.waitForTimeout(500);
      const routed = await win.locator('main.main-content').innerText();
      if (routed.trim().length === 0) empty.push(route.path);
    }
    console.log('Q6 PACKAGED EMPTY ROUTES', JSON.stringify(empty));
    expect(empty).toEqual([]);
  } finally {
    await app.close().catch(() => { /* already gone */ });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
