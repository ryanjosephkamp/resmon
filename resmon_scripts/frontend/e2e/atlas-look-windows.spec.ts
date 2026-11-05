/**
 * The look across windows, in the real app: a theme chosen in one window, and
 * a section hidden from its top bar, show in a second window within a few
 * seconds, with that window never brought to the front (which would read them
 * again on its own): the main process tells it (`relayToOtherWindows`).
 *
 * Nothing leaves this machine, and no search is run.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { ATLAS_LANDMARK, FRONTEND_ROOT, SCREENSHOT_DIR, atlasEnv, launchEnv, registerStateDir } from './fixtures/resmon-app';

const mac = process.platform === 'darwin';
const MOD = mac ? 'Meta' : 'Control';

async function launch(stateDir: string): Promise<{ app: ElectronApplication; win: Page; problems: string[] }> {
  const env = atlasEnv(launchEnv(stateDir, true));
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${path.join(stateDir, 'electron-user-data')}`],
    cwd: FRONTEND_ROOT, env, colorScheme: null, timeout: 180_000,
  });
  registerStateDir(stateDir);
  const win = await app.firstWindow({ timeout: 180_000 });
  const problems: string[] = [];
  win.on('pageerror', (error) => problems.push(error.message));
  await win.locator(ATLAS_LANDMARK).waitFor({ timeout: 120_000 });
  return { app, win, problems };
}

const tab = (page: Page, name: string) => page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name, exact: true });

async function shoot(page: Page, name: string) {
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, name) });
}

test('a theme chosen, and a section hidden, in one window show in another without bringing it to the front', async () => {
  test.setTimeout(300_000);
  const stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-look-windows-')));
  const { app, win: first, problems } = await launch(stateDir);
  try {
    const opened = app.waitForEvent('window');
    await first.keyboard.press(`${MOD}+n`);
    const second = await opened;
    second.on('pageerror', (error) => problems.push(`second: ${error.message}`));
    await second.locator(ATLAS_LANDMARK).waitFor({ timeout: 60_000 });
    await first.bringToFront();
    // From here on, the second window is never in front: it counts each time it would be.
    await second.evaluate(() => {
      const counted = window as unknown as { e2eFocused: number };
      counted.e2eFocused = 0;
      window.addEventListener('focus', () => { counted.e2eFocused += 1; });
    });
    const focused = () => second.evaluate(() => (window as unknown as { e2eFocused: number }).e2eFocused);
    const theme = (page: Page) => page.evaluate(() => document.documentElement.dataset.theme);

    const was = await theme(second);
    const choice = was === 'dark' ? 'Light' : 'Dark';
    const to = choice.toLowerCase();
    await first.keyboard.press(`${MOD}+k`);
    await first.getByRole('combobox', { name: 'Search commands' }).fill(choice);
    await first.keyboard.press('Enter');
    await expect.poll(() => theme(first)).toBe(to);
    const asked = Date.now();
    await expect.poll(() => theme(second), { timeout: 4_000 }).toBe(to);
    console.log(`LOOK RELAY theme reached the second window in ${Date.now() - asked} ms`);

    // The top bar's arrangement too.
    await first.evaluate(() => { window.location.hash = '#/settings/top-bar'; });
    await first.getByRole('switch', { name: 'Show Watches in the top bar' }).click();
    await expect(tab(first, 'Watches')).toHaveCount(0);
    await expect(tab(second, 'Watches')).toHaveCount(0, { timeout: 4_000 });
    expect(await focused(), 'the second window was brought to the front, so this does not show the relay').toBe(0);
    await shoot(second, 'look-second-window.png');
    await shoot(first, 'look-first-window.png');
    expect(problems).toEqual([]);
  } finally {
    await app.close().catch(() => { /* gone */ });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
