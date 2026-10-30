/**
 * The Atlas renderer, served instead of the classic one when RESMON_UI=atlas,
 * and the frame around every screen.
 *
 * The first case proves the switch in the real app: the Atlas shell loads,
 * reaches its own backend with the window's token, and the classic renderer
 * is not what was served. The rest drive the frame as a person does: the
 * name in the top bar goes home, a click on the bar leaves no ring for the
 * next key to show, the keyboard's shortcuts (and the app menu's items, sent
 * through the bridge) reach every section and start a new search or
 * conversation, and New search starts either kind from anywhere.
 *
 * Nothing leaves this machine: the assistant is the repository's agent-CLI
 * double, and no message is sent to it.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { launchEnv, FRONTEND_ROOT, REPO_ROOT, SCREENSHOT_DIR, registerStateDir } from './fixtures/resmon-app';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

test('RESMON_UI=atlas serves the Atlas shell, connected to its own backend', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-'));
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${path.join(stateDir, 'electron-user-data')}`],
    cwd: FRONTEND_ROOT,
    env: { ...launchEnv(stateDir, true), RESMON_UI: 'atlas' },
    timeout: 180_000,
  });
  try {
    const win = await app.firstWindow({ timeout: 180_000 });
    await expect(win.getByRole('link', { name: 'resmon, Today' })).toBeVisible({ timeout: 60_000 });
    await expect(win.getByRole('navigation', { name: 'Sections' })).toBeVisible();
    // An empty collection: Today says so, which it can only do once the engine has answered.
    await expect(win.locator('.plate-waiting > [role="status"]')).toHaveText(/Your collection is empty/, { timeout: 120_000 });
    const port = await win.evaluate(() => (window as unknown as { resmonAPI: { getBackendPort: () => string } }).resmonAPI.getBackendPort());
    expect(port, 'the installed service port is never used').not.toBe('8742');
    // The classic renderer's sidebar is not on the page.
    await expect(win.locator('.sidebar')).toHaveCount(0);
  } finally {
    await app.close().catch(() => { /* already gone */ });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

/** One Atlas window on an empty engine of its own, with the assistant pointed at the CLI double so Ask's composer takes the caret. */
async function launchAtlas(name: string, width?: number): Promise<{ app: ElectronApplication; win: Page; problems: string[]; done: () => Promise<void> }> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `resmon-e2e-atlas-${name}-`)));
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(stateDir);
  const env: Record<string, string> = { ...launchEnv(stateDir, true), RESMON_UI: 'atlas' };
  if (width) env.RESMON_E2E_WIDTH = String(width);
  const python = execFileSync(env.RESMON_PYTHON ?? 'python3', ['-c', 'import sys;print(sys.executable)'], { env, encoding: 'utf8' }).trim();
  const cli = path.join(root, 'claude');
  fs.writeFileSync(cli, `#!/bin/sh\nexec "${python}" "${path.join(REPO_ROOT, 'resmon_scripts/verification_scripts/fixtures/fake_claude.py')}" "$@"\n`, { mode: 0o755 });
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${path.join(stateDir, 'electron-user-data')}`],
    cwd: FRONTEND_ROOT, env, colorScheme: null, timeout: 180_000,
  });
  registerStateDir(stateDir);
  const win = await app.firstWindow({ timeout: 180_000 });
  const problems: string[] = [];
  win.on('pageerror', (e) => problems.push(e.message));
  await expect(win.getByRole('navigation', { name: 'Sections' })).toBeVisible({ timeout: 120_000 });
  const port = await win.evaluate(() => (window as unknown as { resmonAPI: { getBackendPort(): string } }).resmonAPI.getBackendPort());
  expect(port, 'the installed service port is never used').not.toBe('8742');
  await win.evaluate(async ([p, c]) => {
    const response = await e2eFetch(`http://127.0.0.1:${p}/api/settings/ai`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ settings: { ai_cli_path: c } }),
    });
    if (!response.ok) throw new Error(`settings answered HTTP ${response.status}`);
  }, [port, cli] as const);
  return {
    app, win, problems,
    done: async () => {
      await app.close().catch(() => { /* already gone */ });
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

const hash = (win: Page) => win.evaluate(() => window.location.hash);

/** A modal dialog of a screen's own, as a confirmation would be, open over the page. */
async function openForeignDialog(win: Page): Promise<void> {
  await win.evaluate(() => {
    const dialog = document.createElement('dialog');
    dialog.id = 'e2e-foreign-dialog';
    dialog.textContent = 'A dialog of a screen’s own';
    document.body.append(dialog);
    dialog.showModal();
  });
}
const closeForeignDialog = (win: Page) => win.evaluate(() => document.getElementById('e2e-foreign-dialog')?.remove());

test('the top bar: its name goes home, and a click leaves no ring for the next key', async () => {
  test.setTimeout(240_000);
  const { win, problems, done } = await launchAtlas('bar');
  try {
    const bar = win.locator('header.bar');
    const library = win.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'Library' });
    await library.click();
    await expect(win.getByRole('heading', { name: 'Reading queue', level: 1 })).toBeVisible({ timeout: 30_000 });
    // A toolbar keeps no focus: Shift (part of the screenshot keys) then rings nothing in the bar.
    await win.keyboard.press('Shift');
    expect(await bar.evaluate((node) => node.querySelectorAll(':focus-visible').length)).toBe(0);
    // The keyboard still reaches it, ringed.
    await library.focus();
    await win.keyboard.press('Shift');
    expect(await library.evaluate((node) => node.matches(':focus-visible'))).toBe(true);

    const home = win.getByRole('link', { name: 'resmon, Today' });
    await expect(home).toHaveAttribute('href', '#/today');
    await home.click();
    await expect.poll(() => hash(win)).toBe('#/today');
    expect(await home.evaluate((node) => getComputedStyle(node).textDecorationLine)).toBe('none');
    expect(problems).toEqual([]);
  } finally {
    await done();
  }
});

test('the keyboard: every section, Settings, back and forward, New conversation, New Deep Dive and Sweep, the palette and the sheet', async () => {
  test.setTimeout(240_000);
  const { app, win, problems, done } = await launchAtlas('keys');
  try {
    // — the six sections and Settings, in the top bar's order ------------------------
    const sections = ['#/today', '#/watches', '#/search', '#/library', '#/ask', '#/health'];
    for (const [index, expected] of sections.entries()) {
      await win.keyboard.press(`${MOD}+${index + 1}`);
      await expect.poll(() => hash(win)).toBe(expected);
    }
    await win.keyboard.press(`${MOD}+Comma`);
    await expect.poll(() => hash(win)).toBe('#/settings');

    // — back and forward, one page each, with the History menu's own keys -------------
    await win.keyboard.press(`${MOD}+BracketLeft`);
    await expect.poll(() => hash(win)).toBe('#/health');
    await win.keyboard.press(`${MOD}+BracketLeft`);
    await expect.poll(() => hash(win)).toBe('#/ask');
    await win.keyboard.press(`${MOD}+BracketRight`);
    await expect.poll(() => hash(win)).toBe('#/health');

    // — ⌘N: Ask, a new conversation, the caret in the composer --------------------------
    await win.keyboard.press(`${MOD}+n`);
    await expect.poll(() => hash(win)).toBe('#/ask');
    const composer = win.getByRole('region', { name: 'Conversation' }).getByLabel('Message the assistant');
    await expect(win.getByRole('button', { name: 'New conversation' })).toHaveAttribute('aria-pressed', 'true');
    await expect(composer).toBeFocused({ timeout: 30_000 });

    // — ⌘D and ⇧⌘D: Ask the sources, that kind chosen, the caret in the terms, from a text field too --------
    await win.keyboard.press(`${MOD}+d`);
    await expect.poll(() => hash(win)).toBe('#/search/ask');
    const kind = win.getByRole('group', { name: 'Kind of search' });
    const terms = win.getByLabel('Search terms');
    await expect(kind.getByRole('button', { name: 'Deep Dive' })).toHaveAttribute('aria-pressed', 'true');
    await expect(terms).toBeFocused();
    await win.keyboard.press(`${MOD}+Shift+d`);
    await expect(kind.getByRole('button', { name: 'Deep Sweep' })).toHaveAttribute('aria-pressed', 'true');
    await expect(terms).toBeFocused();
    await expect(win.locator('[data-ask="kept"]')).toHaveCount(0);

    // — in a text field, ? is a question mark; the ⌘ shortcuts still work -------------
    await terms.pressSequentially('why?');
    await expect(terms).toHaveValue('why?');
    await expect(win.locator('dialog.keys-sheet')).not.toHaveAttribute('open');
    await win.keyboard.press(`${MOD}+1`);
    await expect.poll(() => hash(win)).toBe('#/today');
    // The address changes before the screen does: the field is gone once Today is drawn.
    await expect(terms).toHaveCount(0);

    // — ? outside a field: the sheet, in this platform's key names --------------------
    await win.keyboard.press('Shift+Slash');
    const sheet = win.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(sheet).toBeVisible();
    const mac = process.platform === 'darwin';
    await expect(sheet.locator('[data-shortcut="new-sweep"] kbd')).toHaveText(mac ? '⇧⌘D' : 'Ctrl+Shift+D');
    await expect(sheet.locator('[data-shortcut="section-4"] dt')).toHaveText('Library');
    await expect(sheet.locator('[data-shortcut="back"] kbd')).toHaveText(mac ? ['⌘[', '⌘←'] : ['Ctrl+[', 'Alt+←']);
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-shell-shortcuts.png') });
    // A shortcut pressed in the sheet closes it and does what it says.
    await win.keyboard.press(`${MOD}+2`);
    await expect(sheet).toBeHidden();
    await expect.poll(() => hash(win)).toBe('#/watches');

    // — the palette lists each command with its shortcut, and runs the shell's own ----
    await win.keyboard.press(`${MOD}+k`);
    const palette = win.getByRole('dialog', { name: 'Search commands' });
    await expect(palette).toBeVisible();
    const row = (label: string) => palette.getByRole('option', { name: new RegExp(`^${label}`) });
    await expect(row('New Deep Sweep').locator('kbd')).toHaveText(mac ? '⇧⌘D' : 'Ctrl+Shift+D');
    await expect(row('Health').locator('kbd')).toHaveText(mac ? '⌘6' : 'Ctrl+6');
    await win.getByRole('combobox', { name: 'Search commands' }).fill('calendar');
    await expect(palette.getByRole('option').first()).toHaveText(/^Calendar/);
    await win.keyboard.press('Enter');
    await expect.poll(() => hash(win)).toBe('#/watches/calendar');
    // A shortcut pressed in the palette closes it and does what it says.
    await win.keyboard.press(`${MOD}+k`);
    await expect(palette).toBeVisible();
    await win.keyboard.press(`${MOD}+3`);
    await expect(palette).toBeHidden();
    await expect.poll(() => hash(win)).toBe('#/search');
    await win.keyboard.press(`${MOD}+k`);
    await win.getByRole('combobox', { name: 'Search commands' }).fill('keyboard');
    await win.keyboard.press('Enter');
    await expect(sheet).toBeVisible();
    await win.keyboard.press('Escape');
    await expect(sheet).toBeHidden();

    // — nothing while a dialog of a screen's own is open, not even the menu's keys -----
    await openForeignDialog(win);
    for (const key of [`${MOD}+3`, `${MOD}+n`, `${MOD}+BracketLeft`, `${MOD}+k`]) await win.keyboard.press(key);
    await win.waitForTimeout(500);
    expect(await hash(win)).toBe('#/search');
    await expect(palette).toBeHidden();
    await closeForeignDialog(win);

    // — the app menu carries the same keys, and its items reach the renderer -------------
    const item = (id: string) => app.evaluate(({ Menu }, which) => {
      const found = Menu.getApplicationMenu()?.getMenuItemById(which);
      return found ? { label: found.label, accelerator: found.accelerator ?? null } : null;
    }, id);
    const click = (id: string) => app.evaluate(({ Menu }, which) => { Menu.getApplicationMenu()?.getMenuItemById(which)?.click(); }, id);
    expect(await item('file-new-conversation')).toEqual({ label: 'New Conversation', accelerator: 'CmdOrCtrl+N' });
    expect(await item('file-new-dive')).toEqual({ label: 'New Deep Dive', accelerator: 'CmdOrCtrl+D' });
    expect(await item('file-new-sweep')).toEqual({ label: 'New Deep Sweep', accelerator: 'Shift+CmdOrCtrl+D' });
    expect((await item('app-settings'))?.accelerator).toBe('CmdOrCtrl+,');
    expect((await item('help-shortcuts'))?.label).toBe('Keyboard Shortcuts');
    await click('file-new-sweep');
    await expect.poll(() => hash(win)).toBe('#/search/ask');
    await expect(kind.getByRole('button', { name: 'Deep Sweep' })).toHaveAttribute('aria-pressed', 'true');
    await click('file-new-conversation');
    await expect.poll(() => hash(win)).toBe('#/ask');
    await click('app-settings');
    await expect.poll(() => hash(win)).toBe('#/settings');
    await click('help-shortcuts');
    await expect(sheet).toBeVisible();
    await win.keyboard.press('Escape');
    // A menu item does nothing over a screen's own dialog either.
    await openForeignDialog(win);
    await click('file-new-dive');
    await win.waitForTimeout(500);
    expect(await hash(win)).toBe('#/settings');
    await closeForeignDialog(win);
    expect(problems).toEqual([]);
  } finally {
    await done();
  }
});

test('New search: a Deep Dive or a Deep Sweep from any screen, and a search not yet started is kept', async () => {
  test.setTimeout(240_000);
  const { win, problems, done } = await launchAtlas('new-search', 1280);
  try {
    const trigger = win.getByRole('button', { name: 'New search' });
    const menu = win.getByRole('menu', { name: 'New search' });
    const kind = win.getByRole('group', { name: 'Kind of search' });
    const terms = win.getByLabel('Search terms');
    const kept = win.locator('[data-ask="kept"]');

    // At 1280 pixels the bar holds every section, New search, and the command search, without overlap.
    const boxes = await win.locator('header.bar').evaluate((bar) => [...bar.querySelectorAll('.tabs li, .newsearch, .cmdk, .iconbtn')]
      .map((node) => node.getBoundingClientRect()).map((r) => ({ left: r.left, right: r.right })));
    for (let i = 1; i < boxes.length; i += 1) expect(boxes[i]!.left).toBeGreaterThanOrEqual(boxes[i - 1]!.right);
    expect(boxes[boxes.length - 1]!.right).toBeLessThanOrEqual(1280);

    // — from the bar, by the pointer --------------------------------------------------
    await trigger.click();
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Deep Dive' })).toBeFocused();
    expect(await menu.getByRole('menuitem', { name: 'Deep Dive' }).evaluate((node) => node.matches(':focus-visible'))).toBe(false);
    await expect(menu.getByRole('menuitem', { name: 'Deep Sweep' })).toHaveAttribute('aria-keyshortcuts',
      process.platform === 'darwin' ? 'Meta+Shift+D' : 'Control+Shift+D');
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-shell-new-search.png') });
    await win.keyboard.press('ArrowDown');
    await expect(menu.getByRole('menuitem', { name: 'Deep Sweep' })).toBeFocused();
    await win.keyboard.press('Enter');
    await expect(menu).toBeHidden();
    await expect.poll(() => hash(win)).toBe('#/search/ask');
    await expect(kind.getByRole('button', { name: 'Deep Sweep' })).toHaveAttribute('aria-pressed', 'true');
    await expect(terms).toBeFocused();

    // — asked again on the form itself: the same page, replaced, not a second one -------
    const length = await win.evaluate(() => window.history.length);
    await win.keyboard.press(`${MOD}+d`);
    await expect(kind.getByRole('button', { name: 'Deep Dive' })).toHaveAttribute('aria-pressed', 'true');
    expect(await win.evaluate(() => window.history.length)).toBe(length);

    // — a search not yet started is kept, said, and can be started over -----------------
    await terms.fill('perovskite');
    await terms.press('Enter');
    await win.keyboard.press(`${MOD}+Shift+d`);
    await expect(kept).toHaveText(/^Kept the search you had not started, as a Deep Sweep\./);
    await expect(win.locator('.term', { hasText: 'perovskite' })).toBeVisible();
    await expect(kind.getByRole('button', { name: 'Deep Sweep' })).toHaveAttribute('aria-pressed', 'true');
    // Two sources chosen: a Deep Dive would keep one, so the sweep stays and says why.
    const sources = win.locator('.source input');
    await sources.nth(0).check();
    await sources.nth(1).check();
    await win.keyboard.press(`${MOD}+d`);
    await expect(kept).toHaveText(/^Kept the Deep Sweep you had not started: a Deep Dive asks one source, and 2 are chosen\./);
    await expect(kind.getByRole('button', { name: 'Deep Sweep' })).toHaveAttribute('aria-pressed', 'true');
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-shell-kept.png') });
    await kept.getByRole('button', { name: 'Start over' }).click();
    await expect(kept).toHaveCount(0);
    await expect(kind.getByRole('button', { name: 'Deep Dive' })).toHaveAttribute('aria-pressed', 'true');
    await expect(win.locator('.term')).toHaveCount(0);
    await expect(win.locator('.source input:checked')).toHaveCount(0);
    await expect(terms).toBeFocused();

    // — from the top of Search ----------------------------------------------------------
    await win.getByRole('navigation', { name: 'Search' }).getByRole('link', { name: 'Your collection' }).click();
    const more = win.getByRole('group', { name: 'Ask the sources for more papers' });
    await more.getByRole('link', { name: 'Deep Sweep' }).click();
    await expect.poll(() => hash(win)).toBe('#/search/ask');
    await expect(kind.getByRole('button', { name: 'Deep Sweep' })).toHaveAttribute('aria-pressed', 'true');
    await expect(terms).toBeFocused();
    expect(problems).toEqual([]);
  } finally {
    await done();
  }
});
