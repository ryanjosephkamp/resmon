/**
 * The Atlas appearance, in the real app: a theme and an accent chosen in
 * Settings are stored by the engine and come back on the next launch, the
 * window opens on that theme's ground before the page paints, and the command
 * palette changes the theme too.
 *
 * Two launches over one state directory, because "comes back" is the claim and
 * one launch cannot test it: the renderer is served from a new port each time,
 * so nothing it kept for itself would survive the second.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { launchEnv, registerStateDir, FRONTEND_ROOT, SCREENSHOT_DIR } from './fixtures/resmon-app';

test.describe.configure({ mode: 'serial' });

async function launch(stateDir: string): Promise<{ app: ElectronApplication; win: Page; problems: string[] }> {
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${path.join(stateDir, 'electron-user-data')}`],
    cwd: FRONTEND_ROOT,
    env: { ...launchEnv(stateDir, true), RESMON_UI: 'atlas' },
    // Playwright otherwise tells the page the system is light, whatever it is,
    // while the main process reads the real one; the two must agree here.
    colorScheme: null,
    timeout: 180_000,
  });
  registerStateDir(stateDir);
  const win = await app.firstWindow({ timeout: 180_000 });
  // Every console error the page reports, a refused-by-policy load included.
  const problems: string[] = [];
  win.on('console', (message) => { if (message.type() === 'error') problems.push(message.text()); });
  win.on('pageerror', (error) => problems.push(error.message));
  await expect(win.getByRole('navigation', { name: 'Sections' })).toBeVisible({ timeout: 120_000 });
  return { app, win, problems };
}

/** `#0A0A0B`, `#ff0a0a0b`, `rgb(10, 10, 11)` → `0a0a0b`. */
function hex6(value: string): string {
  const rgb = value.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (rgb) return rgb.slice(1, 4).map((n) => Number(n).toString(16).padStart(2, '0')).join('');
  const hex = value.trim().replace(/^#/, '').toLowerCase();
  return hex.length === 8 ? hex.slice(-6) : hex;
}

async function grounds(app: ElectronApplication, win: Page) {
  const windowBg = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getBackgroundColor() ?? '');
  const bodyBg = await win.evaluate(() => getComputedStyle(document.body).backgroundColor);
  return { window: hex6(windowBg), body: hex6(bodyBg) };
}

/** What the engine holds, read the way any other client would. */
async function storedAppearance(win: Page): Promise<unknown> {
  const port = await win.evaluate(() => (window as unknown as { resmonAPI: { getBackendPort: () => string } }).resmonAPI.getBackendPort());
  const response = await e2eFetch(`http://127.0.0.1:${port}/api/appearance`);
  return response.json();
}

const pageTheme = (win: Page) => win.evaluate(() => document.documentElement.dataset.theme);
const pageAccent = (win: Page) => win.evaluate(() => document.documentElement.style.getPropertyValue('--accent'));

async function shoot(win: Page, name: string) {
  // After every running animation (the palette's entrance, a theme's frame)
  // has finished, so the picture is of a state and not of a transition.
  await win.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await win.screenshot({ path: path.join(SCREENSHOT_DIR, name) });
}

test('a theme and an accent chosen in Settings come back on the next launch', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-look-'));
  try {
    // First launch: choose dark and a blue accent.
    {
      const { app, win, problems } = await launch(stateDir);
      try {
        await win.getByRole('link', { name: 'Settings', exact: true }).click();
        await expect(win.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
        await win.locator('.theme-card', { hasText: 'The night chart' }).click();
        await expect.poll(() => pageTheme(win)).toBe('dark');

        const hex = win.getByRole('textbox', { name: 'Hex color' });
        await hex.fill('#3D8AFF');
        await hex.press('Enter');
        await expect.poll(() => pageAccent(win)).toBe('#3d8aff');
        // Chosen one after the other, quickly: both have to be stored.
        await expect.poll(() => storedAppearance(win)).toEqual({ theme: 'dark', accent: '#3d8aff' });
        await expect(win.locator('.theme-card[data-selected]')).toHaveText(/The night chart/);
        await expect(win.getByText('Drawn exactly as chosen.')).toHaveCount(1);
        await shoot(win, 'atlas-settings-dark.png');

        expect(problems, 'the page reported errors').toEqual([]);
      } finally {
        await app.close().catch(() => { /* already gone */ });
      }
    }

    // Second launch: the window opens dark, the page is dark and blue before
    // anything is touched, and the two grounds agree.
    {
      const { app, win, problems } = await launch(stateDir);
      try {
        expect(await pageTheme(win)).toBe('dark');
        expect(await pageAccent(win)).toBe('#3d8aff');
        expect(await grounds(app, win)).toEqual({ window: '0a0a0b', body: '0a0a0b' });

        // The palette changes the theme as well.
        await win.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
        const field = win.getByRole('combobox', { name: 'Search commands' });
        await expect(field).toBeFocused();
        await field.fill('light');
        await shoot(win, 'atlas-palette-dark.png');
        await field.press('Enter');
        await expect(win.getByRole('dialog')).toBeHidden();
        await expect.poll(() => pageTheme(win)).toBe('light');
        await expect.poll(() => storedAppearance(win)).toEqual({ theme: 'light', accent: '#3d8aff' });

        await win.getByRole('link', { name: 'Settings', exact: true }).click();
        await expect(win.locator('.theme-card[data-selected]')).toHaveText(/The printed atlas/);
        await expect(win.getByText('Drawn deeper here, so it stays readable.')).toHaveCount(1);
        await shoot(win, 'atlas-settings-light.png');
        await win.getByRole('link', { name: 'Today' }).click();
        await expect(win.locator('.plate-waiting > [role="status"]')).toHaveText(/Your collection is empty/);
        await shoot(win, 'atlas-today-light.png');

        expect(problems, 'the page reported errors').toEqual([]);
      } finally {
        await app.close().catch(() => { /* already gone */ });
      }
    }

    // Third launch: light now, on a white window.
    {
      const { app, win } = await launch(stateDir);
      try {
        expect(await pageTheme(win)).toBe('light');
        expect(await grounds(app, win)).toEqual({ window: 'ffffff', body: 'ffffff' });
      } finally {
        await app.close().catch(() => { /* already gone */ });
      }
    }
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
