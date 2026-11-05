/**
 * The top bar as a person arranges it, in the real app: Settings › Top bar
 * reorders the sections by the keyboard's arrows and by a drag, hides two,
 * and chooses the start page and where the resmon name goes; the bar, ⌘1 to
 * ⌘7, the command palette, and the Keyboard shortcuts sheet follow at once; a
 * hidden section is still reached by its shortcut, the palette, and its
 * address; a new window (⌘N) and the next launch open on the start page with
 * the same bar, because the engine keeps it (`/api/top-bar`).
 *
 * Then every section hidden: the bar keeps the resmon name, the run monitor,
 * New search, the command search, and Settings, and Settings is reached by its
 * button and by ⌘,. At the default window and at the 960 by 640 minimum, the
 * bar's controls sit side by side inside the window, with all seven shown and
 * with some hidden.
 *
 * Nothing leaves this machine: no search is run, and the state directory is
 * the spec's own.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { ATLAS_LANDMARK, FRONTEND_ROOT, SCREENSHOT_DIR, atlasEnv, launchEnv, registerStateDir } from './fixtures/resmon-app';

test.describe.configure({ mode: 'serial' });

const mac = process.platform === 'darwin';
const MOD = mac ? 'Meta' : 'Control';
const key = (n: number | string) => (mac ? `⌘${n}` : `Ctrl+${n}`);
const DEFAULT = ['Today', 'Watches', 'Search', 'Runs', 'Library', 'Ask', 'Health'];

async function launch(stateDir: string): Promise<{ app: ElectronApplication; win: Page; problems: string[] }> {
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${path.join(stateDir, 'electron-user-data')}`],
    cwd: FRONTEND_ROOT,
    env: atlasEnv(launchEnv(stateDir, true)),
    colorScheme: null,
    timeout: 180_000,
  });
  registerStateDir(stateDir);
  const win = await app.firstWindow({ timeout: 180_000 });
  const problems: string[] = [];
  win.on('pageerror', (error) => problems.push(error.message));
  win.on('console', (message) => { if (message.type() === 'error') problems.push(message.text()); });
  // The bar's right end is drawn whatever is hidden: it is what says the shell is up.
  await expect(win.getByRole('link', { name: 'Settings', exact: true })).toBeVisible({ timeout: 120_000 });
  return { app, win, problems };
}

const hash = (win: Page) => win.evaluate(() => window.location.hash);
const tabs = (win: Page) => win.locator(`${ATLAS_LANDMARK} a`).allInnerTexts();

/** What the engine holds, read the way any other client would. */
async function stored(win: Page): Promise<unknown> {
  const port = await win.evaluate(() => (window as unknown as { resmonAPI: { getBackendPort(): string } }).resmonAPI.getBackendPort());
  expect(port, 'the installed service port is never used').not.toBe('8742');
  return (await e2eFetch(`http://127.0.0.1:${port}/api/top-bar`)).json();
}

async function shoot(win: Page, name: string) {
  await win.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await win.screenshot({ path: path.join(SCREENSHOT_DIR, name) });
}

/** The bar's controls side by side, none over another, and the last inside the window. */
async function barFits(win: Page): Promise<void> {
  const inner = await win.evaluate(() => window.innerWidth);
  const boxes = await win.locator('header.bar').evaluate((bar) => [...bar.querySelectorAll(
    '.lockup, .tabs:not([hidden]) li, .run-monitor, .newsearch, .cmdk, :scope > .iconbtn',
  )].map((node) => node.getBoundingClientRect()).filter((r) => r.width > 0).map((r) => ({ left: r.left, right: r.right })));
  for (let i = 1; i < boxes.length; i += 1) expect(boxes[i]!.left, `control ${i} overlaps the one before it`).toBeGreaterThanOrEqual(boxes[i - 1]!.right);
  expect(boxes[boxes.length - 1]!.right).toBeLessThanOrEqual(inner);
  expect(await win.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(inner);
}

test('arranged in Settings: reordered, two hidden, a start page and the name\'s page, followed by the keys and kept across a launch', async () => {
  test.setTimeout(420_000);
  const stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-top-bar-')));
  try {
    {
      const { app, win, problems } = await launch(stateDir);
      try {
        expect(await tabs(win)).toEqual(DEFAULT);
        expect(await stored(win)).toEqual({
          order: ['today', 'watches', 'search', 'runs', 'library', 'ask', 'health'], hidden: [], start: '/today', lockup: null,
        });

        // — Settings › Top bar, by name from the command palette ----------------------------
        await win.keyboard.press(`${MOD}+k`);
        await win.getByRole('combobox', { name: 'Search commands' }).fill('arrange');
        await win.keyboard.press('Enter');
        await expect.poll(() => hash(win)).toBe('#/settings/top-bar');
        await expect(win.getByRole('heading', { name: 'Top bar', level: 2 })).toBeVisible();
        const list = win.getByRole('list', { name: 'Sections' });
        const rows = () => list.locator('li').evaluateAll((items) => items.map((li) => li.getAttribute('data-section')));
        expect(await rows()).toEqual(['today', 'watches', 'search', 'runs', 'library', 'ask', 'health']);

        // — By the keyboard: Health up six places, the focus staying on its arrow ------------
        const healthUp = win.getByRole('button', { name: 'Move Health up' });
        await healthUp.focus();
        for (let i = 0; i < 6; i += 1) await win.keyboard.press('Enter');
        await expect(healthUp).toBeFocused();
        await expect(healthUp).toHaveAttribute('aria-disabled', 'true');
        await expect.poll(() => tabs(win)).toEqual(['Health', 'Today', 'Watches', 'Search', 'Runs', 'Library', 'Ask']);
        await expect(win.getByRole('status').filter({ hasText: 'Health is now 1 of 7' })).toHaveCount(1);

        // — By a drag: Ask, from the end, to second ----------------------------------------
        const askHandle = list.locator('[data-section="ask"] .bar-order-handle');
        const from = (await askHandle.boundingBox())!;
        const top = (await list.locator('[data-section="today"]').boundingBox())!;
        await win.mouse.move(from.x + 40, from.y + from.height / 2);
        await win.mouse.down();
        await win.mouse.move(from.x + 40, top.y + top.height / 2 - 4, { steps: 12 });
        await expect(list).toHaveAttribute('data-dragging', '');
        await expect(list.locator('[data-section="ask"]')).toHaveAttribute('data-lifted', 'true');
        await shoot(win, 'top-bar-dragging.png');
        await win.mouse.up();
        await expect(list).not.toHaveAttribute('data-dragging');
        await expect.poll(rows).toEqual(['health', 'ask', 'today', 'watches', 'search', 'runs', 'library']);
        await expect.poll(() => tabs(win)).toEqual(['Health', 'Ask', 'Today', 'Watches', 'Search', 'Runs', 'Library']);

        // — Two hidden, each kept in its place in the list ----------------------------------
        for (const name of ['Watches', 'Runs']) {
          const shown = win.getByRole('switch', { name: `Show ${name} in the top bar` });
          await shown.click();
          await expect(shown).toHaveAttribute('aria-checked', 'false');
        }
        await expect.poll(() => tabs(win)).toEqual(['Health', 'Ask', 'Today', 'Search', 'Library']);
        expect(await rows()).toEqual(['health', 'ask', 'today', 'watches', 'search', 'runs', 'library']);
        // Their keys follow the shown ones.
        await expect(list.locator('[data-section="watches"] kbd')).toHaveText(key(6));
        await expect(list.locator('[data-section="runs"] kbd')).toHaveText(key(7));
        await expect(list.locator('[data-section="search"] kbd')).toHaveText(key(4));

        // — The start page and the resmon name's page --------------------------------------
        await win.getByRole('combobox', { name: /^Start page/ }).selectOption('/search/saved');
        await win.getByRole('combobox', { name: /^The resmon name/ }).selectOption('/health/watchdog');
        await expect.poll(() => stored(win)).toEqual({
          order: ['health', 'ask', 'today', 'watches', 'search', 'runs', 'library'],
          hidden: ['watches', 'runs'],
          start: '/search/saved',
          lockup: '/health/watchdog',
        });
        // The printed atlas, from the palette, for a look at the screen in light.
        await win.keyboard.press(`${MOD}+k`);
        await win.getByRole('combobox', { name: 'Search commands' }).fill('light');
        await win.keyboard.press('Enter');
        await expect.poll(() => win.evaluate(() => document.documentElement.dataset.theme)).toBe('light');
        await shoot(win, 'top-bar-settings-light.png');

        // — ⌘1 to ⌘7 follow the bar, then the hidden sections ------------------------------
        const expected: [number, string][] = [[1, '#/health'], [2, '#/ask'], [3, '#/today'], [5, '#/library'], [6, '#/watches'], [7, '#/runs']];
        for (const [n, to] of expected) {
          await win.keyboard.press(`${MOD}+${n}`);
          await expect.poll(() => hash(win)).toBe(to);
        }
        // A hidden section's own screen, from its address and its key: no tab in the bar is current.
        await expect(win.getByRole('heading', { name: 'Runs', level: 1 })).toBeVisible({ timeout: 30_000 });
        await expect(win.locator(`${ATLAS_LANDMARK} a[aria-current="page"]`)).toHaveCount(0);
        await win.evaluate(() => { window.location.hash = '#/watches/calendar'; });
        await expect(win.getByRole('heading', { name: 'Calendar', level: 1 })).toBeVisible({ timeout: 30_000 });

        // — The palette lists the hidden ones, says so, and opens them -----------------------
        await win.keyboard.press(`${MOD}+3`);
        await expect.poll(() => hash(win)).toBe('#/today');
        await win.keyboard.press(`${MOD}+k`);
        const palette = win.getByRole('dialog', { name: 'Search commands' });
        await win.getByRole('combobox', { name: 'Search commands' }).fill('runs');
        const runsRow = palette.getByRole('option').filter({ has: win.locator('.palette-label', { hasText: /^Runs$/ }) });
        await expect(runsRow).toContainText('Not in the top bar');
        await expect(runsRow.locator('kbd')).toHaveText(key(7));
        await shoot(win, 'top-bar-palette-hidden.png');
        await runsRow.click();
        await expect.poll(() => hash(win)).toBe('#/runs');

        // — The sheet names the keys by the bar's order --------------------------------------
        await win.locator('main.stage').click({ position: { x: 5, y: 5 } });
        await win.keyboard.press('Shift+Slash');
        const sheet = win.getByRole('dialog', { name: 'Keyboard shortcuts' });
        await expect(sheet).toBeVisible();
        await expect(sheet.locator('[data-shortcut="section-1"] dt')).toHaveText('Health');
        await expect(sheet.locator('[data-shortcut="section-6"] dt')).toHaveText('Watchesnot in the top bar');
        await expect(sheet.locator('[data-shortcut="section-6"] kbd')).toHaveText(key(6));
        await sheet.evaluate((node) => Promise.all(document.getAnimations()
          .filter((a) => (a.effect as KeyframeEffect | null)?.target === node).map((a) => a.finished)));
        await shoot(win, 'top-bar-shortcuts-sheet.png');
        await win.keyboard.press('Escape');
        await expect(sheet).toBeHidden();

        // — The resmon name goes to its own page --------------------------------------------
        const lockup = win.getByRole('link', { name: 'resmon, Health › Watchdog' });
        await expect(lockup).toHaveAttribute('href', '#/health/watchdog');
        await lockup.click();
        await expect.poll(() => hash(win)).toBe('#/health/watchdog');
        await shoot(win, 'top-bar-arranged-bar.png');

        // — ⌘N: a new window, at the start page, with the same bar ---------------------------
        const opened = app.waitForEvent('window');
        await win.keyboard.press(`${MOD}+n`);
        const second = await opened;
        await second.getByRole('link', { name: 'Settings', exact: true }).waitFor({ timeout: 60_000 });
        await expect.poll(() => second.evaluate(() => window.location.hash)).toBe('#/search/saved');
        expect(await tabs(second)).toEqual(['Health', 'Ask', 'Today', 'Search', 'Library']);
        await second.close();

        expect(problems, 'the page reported errors').toEqual([]);
      } finally {
        await app.close().catch(() => { /* already gone */ });
      }
    }

    // — The next launch: the start page, the same bar, and Settings as it was left ----------
    {
      const { app, win, problems } = await launch(stateDir);
      try {
        await expect.poll(() => hash(win)).toBe('#/search/saved');
        await expect(win.getByRole('heading', { name: 'Saved', level: 1 })).toBeVisible({ timeout: 30_000 });
        expect(await tabs(win)).toEqual(['Health', 'Ask', 'Today', 'Search', 'Library']);
        await expect(win.getByRole('link', { name: 'resmon, Health › Watchdog' })).toBeVisible();
        await win.keyboard.press(`${MOD}+7`);
        await expect.poll(() => hash(win)).toBe('#/runs');

        await win.evaluate(() => { window.location.hash = '#/settings/top-bar'; });
        await expect(win.getByRole('switch', { name: 'Show Runs in the top bar' })).toHaveAttribute('aria-checked', 'false');
        await expect(win.getByRole('combobox', { name: /^Start page/ })).toHaveValue('/search/saved');
        // The night theme, from the palette, for a look at the same screen.
        await win.keyboard.press(`${MOD}+k`);
        await win.getByRole('combobox', { name: 'Search commands' }).fill('dark');
        await win.keyboard.press('Enter');
        await expect.poll(() => win.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
        await shoot(win, 'top-bar-settings-dark.png');
        expect(problems, 'the page reported errors').toEqual([]);
      } finally {
        await app.close().catch(() => { /* already gone */ });
      }
    }
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('every section hidden: Settings is still reached, and at 960 by 640 the bar fits with all seven and with some hidden', async () => {
  test.setTimeout(300_000);
  const stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-top-bar-none-')));
  const { app, win, problems } = await launch(stateDir);
  const resize = async (width: number, height: number) => {
    await app.evaluate(({ BrowserWindow }, [w, h]) => { BrowserWindow.getAllWindows()[0]?.setSize(w, h); }, [width, height] as const);
    await expect.poll(() => win.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(width);
  };
  try {
    await win.evaluate(() => { window.location.hash = '#/settings/top-bar'; });
    const switchFor = (name: string) => win.getByRole('switch', { name: `Show ${name} in the top bar` });
    await expect(switchFor('Today')).toBeVisible({ timeout: 30_000 });

    // — Every section hidden, at the default window ---------------------------------------
    for (const name of DEFAULT) await switchFor(name).click();
    await expect.poll(() => stored(win)).toEqual({
      order: ['today', 'watches', 'search', 'runs', 'library', 'ask', 'health'],
      hidden: ['today', 'watches', 'search', 'runs', 'library', 'ask', 'health'],
      start: '/today',
      lockup: null,
    });
    await expect(win.locator(ATLAS_LANDMARK)).toBeHidden();
    const settings = win.getByRole('link', { name: 'Settings', exact: true });
    await expect(settings).toBeVisible();
    await expect(win.getByRole('button', { name: 'New search' })).toBeVisible();
    await barFits(win);
    await shoot(win, 'top-bar-none-shown-1440.png');

    // Settings by its button and by ⌘,, from a section that is out of the bar.
    await win.keyboard.press(`${MOD}+1`);
    await expect.poll(() => hash(win)).toBe('#/today');
    await settings.click();
    await expect.poll(() => hash(win)).toBe('#/settings');
    await win.keyboard.press(`${MOD}+5`);
    await expect.poll(() => hash(win)).toBe('#/library');
    await win.keyboard.press(`${MOD}+Comma`);
    await expect.poll(() => hash(win)).toBe('#/settings');
    // The palette still goes to every section.
    await win.keyboard.press(`${MOD}+k`);
    const palette = win.getByRole('dialog', { name: 'Search commands' });
    await expect(palette.getByRole('option').filter({ hasText: 'Not in the top bar' })).toHaveCount(7);
    await win.keyboard.press('Escape');

    // — The same at the window's 960 by 640 minimum --------------------------------------
    await resize(960, 640);
    await win.evaluate(() => { window.location.hash = '#/settings/top-bar'; });
    await expect(settings).toBeVisible();
    await barFits(win);
    await shoot(win, 'top-bar-none-shown-960.png');
    await settings.click();
    await expect.poll(() => hash(win)).toBe('#/settings');

    // — Reset: all seven again, and the bar still fits at 960, the run monitor and New search in it -----
    await win.evaluate(() => { window.location.hash = '#/settings/top-bar'; });
    await win.getByRole('button', { name: 'Reset the top bar' }).click();
    await expect.poll(() => tabs(win)).toEqual(DEFAULT);
    await expect(win.getByRole('button', { name: 'Reset the top bar' })).toBeDisabled();
    await expect(win.locator('header.bar .run-monitor')).toBeVisible();
    await barFits(win);
    await shoot(win, 'top-bar-settings-960.png');
    await win.evaluate(() => { window.location.hash = '#/today'; });
    await barFits(win);
    await shoot(win, 'top-bar-all-shown-960.png');

    // — Some hidden, at 960 -------------------------------------------------------------
    await win.evaluate(() => { window.location.hash = '#/settings/top-bar'; });
    for (const name of ['Watches', 'Ask']) await switchFor(name).click();
    await expect.poll(() => tabs(win)).toEqual(['Today', 'Search', 'Runs', 'Library', 'Health']);
    await barFits(win);
    await win.evaluate(() => { window.location.hash = '#/runs'; });
    await barFits(win);
    await shoot(win, 'top-bar-some-hidden-960.png');
    expect(problems, 'the page reported errors').toEqual([]);
  } finally {
    await app.close().catch(() => { /* already gone */ });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
