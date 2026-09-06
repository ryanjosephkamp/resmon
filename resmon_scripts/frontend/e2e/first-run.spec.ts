/**
 * P15a in the real window: the first-run card on a genuinely fresh install.
 *
 * jsdom can render the card from a mocked payload and the backend suite can
 * decide when to send one, and between them they still cannot answer the
 * question this spec exists for: **does a person who installs resmon and opens
 * it actually see this?** The e2e fixture launches the real Electron app over a
 * brand-new temp state directory — an empty database, no settings, no history —
 * which is the closest thing to a first launch that a test can be.
 *
 * The other half is that it goes away and stays away. Dismissal is stored, so
 * "it disappeared" and "it will not come back" are two claims; the reload here
 * is what separates them.
 *
 * **Not covered here, deliberately:** the history condition — that a routine or
 * an execution retires the card — is asserted at the backend boundary in
 * `test_onboarding.py` against a real database, one column at a time. Repeating
 * it here would cost a second app launch to observe the same decision through
 * one more layer.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { launchEnv, FRONTEND_ROOT } from './fixtures/resmon-app';

test.describe.configure({ mode: 'serial' });

interface Launched { app: ElectronApplication; win: Page; close: () => Promise<void>; }

async function launch(): Promise<Launched> {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-firstrun-'));
  const env = launchEnv(stateDir, true);
  if (env.RESMON_PYTHON && !path.isAbsolute(env.RESMON_PYTHON)) {
    try {
      env.RESMON_PYTHON = execFileSync(
        process.platform === 'win32' ? 'where' : 'which',
        [env.RESMON_PYTHON], { encoding: 'utf8' },
      ).split('\n')[0].trim();
    } catch { /* the launch failure below will say so */ }
  }
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${path.join(stateDir, 'electron-user-data')}`],
    cwd: FRONTEND_ROOT, env, timeout: 180_000,
  });
  const win = await app.firstWindow({ timeout: 180_000 });
  await win.waitForLoadState('domcontentloaded');
  await win.locator('.app-main').waitFor({ state: 'visible', timeout: 60_000 });
  const port = await win.evaluate(
    () => (window as unknown as { resmonAPI: { getBackendPort(): string } })
      .resmonAPI.getBackendPort(),
  );
  expect(port, 'the e2e app must never attach to the live daemon').not.toBe('8742');
  return {
    app, win,
    close: async () => {
      await app.close().catch(() => { /* already gone */ });
      fs.rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

test('P15: a fresh install sees the card, and Skip retires it for good', async () => {
  const { win, close } = await launch();
  try {
    const card = win.getByTestId('first-run-card');
    await expect(card).toBeVisible({ timeout: 30_000 });

    // Three rows, each naming a destination the user can reach from here.
    for (const id of ['agent_cli', 'ai_key', 'repository_key']) {
      await expect(win.getByTestId(`first-run-step-${id}`)).toBeVisible();
    }

    // It says the list is optional. A first screen that reads as a set of
    // prerequisites makes resmon look like it cannot search without an AI, and
    // it can: 25 sources, no key, no model.
    await expect(card).toContainText(/optional/i);
    await expect(card).toContainText(/not the same as working/i);

    // And it is not in the layout's way: the card sits above the page's own
    // content rather than replacing it.
    await expect(win.locator('.card', { hasText: 'Active Routines' })).toBeVisible();

    await win.getByRole('button', { name: 'Skip' }).click();
    await expect(card).toBeHidden({ timeout: 10_000 });

    // Reload the renderer against the same backend and the same database. This
    // is the half that separates "it disappeared" from "it is gone".
    await win.reload();
    await win.locator('.app-main').waitFor({ state: 'visible', timeout: 60_000 });
    await win.waitForTimeout(1_000);
    await expect(win.getByTestId('first-run-card')).toHaveCount(0);
  } finally {
    await close();
  }
});
