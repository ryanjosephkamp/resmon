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
 *
 * **And it skips when the build under `release/` is not this checkout's.** The
 * spike's precondition was "a directory exists", which is not the same claim:
 * on a machine whose `release/` still held a **1.6.0** bundle from months
 * earlier, this spec launched that app, walked its routes, and failed on a
 * window-size branch three releases older than the code under test. A stale
 * pass would have been worse than the failure — it would have reported the
 * shipped bundle as verified while never opening it. `npm run dist` first.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test, expect, _electron as electron } from '@playwright/test';
import { launchEnv, FRONTEND_ROOT, WINDOW_WIDTH } from './fixtures/resmon-app';
import { readFuses, FUSES_VERIFICATION_DEPENDS_ON, fuseBinaryFor } from './fixtures/electron-fuses';
import { ROUTES } from './routes';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const CHECKOUT_VERSION: string = require(path.join(FRONTEND_ROOT, 'package.json')).version;

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

/**
 * The version electron-builder stamped into the bundle, without launching it.
 *
 * macOS keeps it in `Contents/Info.plist`; on Windows and Linux the app's own
 * `package.json` travels inside `resources/app.asar`, which is not readable
 * without unpacking, so `resources/app-update.yml` — which electron-builder
 * writes next to it — is used instead. Returns null when it cannot be read,
 * and the caller treats that as a mismatch rather than as a pass.
 */
function packagedAppVersion(exe: string): string | null {
  try {
    if (process.platform === 'darwin') {
      const plist = path.resolve(exe, '..', '..', 'Info.plist');
      const m = fs.readFileSync(plist, 'utf8')
        .match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/);
      return m ? m[1] : null;
    }
    const yml = path.join(path.dirname(exe), 'resources', 'app-update.yml');
    const m = fs.readFileSync(yml, 'utf8').match(/^version:\s*(\S+)/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

test('D4: the two fuses packaged verification depends on are still enabled', () => {
  const exe = packagedExecutable();
  test.skip(exe === null, 'no packaged app under release/ — run `npm run dist` first');
  const fuses = readFuses(exe as string);
  console.log('D4 FUSES', JSON.stringify({ binary: fuseBinaryFor(exe as string), fuses }));
  expect(fuses, `no fuse wire found in ${fuseBinaryFor(exe as string)}`).toBeTruthy();
  for (const name of FUSES_VERIFICATION_DEPENDS_ON) {
    expect(
      (fuses as Record<string, string>)[name],
      `${name} is not enabled in the packaged app. Packaged-app verification `
      + 'drives the main process over the Node inspector and stops working '
      + 'without it — see docs/ui-verification-feasibility.md, Q6. If this was '
      + 'a deliberate hardening change, packaged verification has to be '
      + 'replaced, not merely re-enabled.',
    ).toBe('enabled');
  }
});

test('Q6: the packaged app launches under Playwright and serves every route', async () => {
  const exe = packagedExecutable();
  test.skip(
    exe === null,
    'no packaged app found under resmon_scripts/frontend/release — run `npm run dist` first',
  );
  test.setTimeout(300_000);

  // What was built, read from the bundle rather than assumed from its
  // existence. `app.getVersion()` would answer this too, but only after a
  // launch — and launching the wrong app is the failure being prevented.
  const packagedVersion = packagedAppVersion(exe as string);
  // Printed as well as annotated: Playwright's list reporter shows a skip as a
  // dash, and a run that quietly did not verify the shipped app is exactly the
  // thing this guard exists to make legible.
  console.log('Q6 PACKAGED APP VERSION', JSON.stringify(
    { packaged: packagedVersion, checkout: CHECKOUT_VERSION, executable: exe },
  ));
  test.skip(
    packagedVersion !== CHECKOUT_VERSION,
    `the packaged app under release/ is ${packagedVersion ?? 'unreadable'}, `
    + `this checkout is ${CHECKOUT_VERSION} — run \`npm run dist\` to rebuild it`,
  );

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
