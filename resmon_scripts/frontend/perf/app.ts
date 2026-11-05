/**
 * Starting the real app for a measurement, isolated: its own state folder,
 * database, reports, port file, and Chromium profile, the null keyring, and a
 * launchctl that starts nothing. Shared by the interface's measurements
 * (`ui.perf.ts`, `scroll.perf.ts`), so each starts the app the same way.
 */
import { _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export const SERVICE_PORT = '8742';

export function cloneFile(src: string, dst: string): void {
  if (process.platform === 'darwin') {
    try {
      execFileSync('cp', ['-c', src, dst]);
      return;
    } catch { /* not APFS; copy below */ }
  }
  fs.copyFileSync(src, dst);
}

export function isolatedEnv(state: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string' && !key.startsWith('RESMON_') ) env[key] = value;
  }
  // The same isolation as e2e/fixtures/resmon-app.ts: every state path pinned,
  // the null keyring (a local run once erased someone's real keys), and a
  // fixed window size so a run on a large display and a small one draw the
  // same page. RESMON_E2E also keeps a packaged build off the update feed.
  Object.assign(env, {
    RESMON_STATE_DIR: state,
    RESMON_DB_PATH: path.join(state, 'resmon.db'),
    RESMON_REPORTS_DIR: path.join(state, 'reports'),
    RESMON_PORT_FILE: path.join(state, 'resmon.port'),
    PYTHON_KEYRING_BACKEND: 'keyring.backends.null.Keyring',
    RESMON_E2E: '1',
    RESMON_E2E_WIDTH: '1440',
    RESMON_E2E_HEIGHT: '900',
    // An AI command only where one is configured. Left to search the
    // installers' locations and PATH, the engine finds the person's own
    // signed-in `claude` or `codex`, and Settings › AI and Ask run its sign-in
    // check whenever they are opened. The seeded corpus names none.
    RESMON_AI_CLI_DISCOVERY: 'configured-only',
    // Where the background service's unit would be read, so whether the
    // person's own resmon service is installed changes nothing on screen.
    RESMON_SERVICE_UNIT_DIR: path.join(state, 'service-units'),
    // And launchd's: a label of its own and a launchctl that starts nothing.
    RESMON_SERVICE_LABEL: 'com.resmon.perf',
    RESMON_LAUNCHCTL: path.resolve(__dirname, '..', '..', 'verification_scripts', 'fixtures', 'fake_launchctl.py'),
  });
  for (const key of ['RESMON_BACKGROUND_WINDOW', 'RESMON_PYTHON']) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
}

export async function launchApp(state: string, initScript?: string): Promise<{ app: ElectronApplication; win: Page; started: number; firstWindow: number }> {
  const executable = process.env.RESMON_PERF_EXECUTABLE;
  const frontend = process.env.RESMON_PERF_FRONTEND || path.resolve(__dirname, '..');
  const userData = `--user-data-dir=${path.join(state, 'electron-user-data')}`;
  const started = Date.now();
  const app = executable
    ? await electron.launch({ executablePath: executable, args: [userData], env: isolatedEnv(state), timeout: 180_000 })
    : await electron.launch({ args: ['.', userData], cwd: frontend, env: isolatedEnv(state), timeout: 180_000 });
  if (initScript) await app.context().addInitScript(initScript);
  // Nothing the app's pages ask of the internet is answered by the internet:
  // every request is refused as if the machine were offline. Only https is
  // routed -- the backend is plain http on loopback -- so no API call pays for
  // an interception.
  await app.context().route('https://**', (route) => route.abort('internetdisconnected'));
  const win = await app.firstWindow({ timeout: 180_000 });
  const firstWindow = Date.now();
  const port = await win.evaluate(async () => {
    type Bridge = { getBackendPort?: () => number | string | null };
    const bridge = (window as unknown as { resmonAPI?: Bridge }).resmonAPI;
    for (let i = 0; i < 600; i += 1) {
      const value = bridge?.getBackendPort?.();
      if (value) return String(value);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return '';
  });
  if (port === SERVICE_PORT) {
    await app.close();
    throw new Error('the app attached to the installed service port; refusing');
  }
  return { app, win, started, firstWindow };
}

