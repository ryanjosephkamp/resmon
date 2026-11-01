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
 * conversation, New search starts either kind from anywhere, and a
 * two-finger swipe, sent as the wheel events a trackpad sends, goes back and
 * forward once per swipe and leaves alone what is not its own.
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
import { SCREEN_PATHS } from '../atlas/src/screenPaths';

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

test('opening a screen writes nothing into the frame’s fields', async () => {
  // The palette's field, drawn on every change of screen while closed, had its
  // `name` and `type` written again each time: three changes to the page at
  // the very moment a screen settled.
  test.setTimeout(240_000);
  const { win, problems, done } = await launchAtlas('frame');
  try {
    await win.evaluate(() => {
      const seen: string[] = [];
      (window as unknown as { e2eFrameChanges: string[] }).e2eFrameChanges = seen;
      new MutationObserver((records) => {
        for (const record of records) {
          const node = record.target as Element;
          if (node.tagName === 'INPUT' && !node.closest('main.stage')) seen.push(`${record.attributeName} on ${node.outerHTML.slice(0, 120)}`);
        }
      }).observe(document, { subtree: true, attributes: true });
    });
    for (const screen of SCREEN_PATHS) {
      await win.evaluate((to) => { window.location.hash = to; }, `#${screen.path}`);
      await expect.poll(() => hash(win)).toBe(`#${screen.path}`);
    }
    await win.evaluate(() => { window.location.hash = '#/today'; });
    await expect.poll(() => hash(win)).toBe('#/today');
    expect(await win.evaluate(() => (window as unknown as { e2eFrameChanges: string[] }).e2eFrameChanges)).toEqual([]);

    // Opened, the palette's field is there, empty and holding the caret; closed, it is gone again.
    await win.getByRole('button', { name: 'Search commands' }).click();
    const field = win.getByRole('dialog', { name: 'Search commands' }).getByRole('combobox');
    await expect(field).toBeFocused();
    await field.fill('cal');
    await win.keyboard.press('Escape');
    await expect(win.locator('dialog.palette input')).toHaveCount(0);
    await win.getByRole('button', { name: 'Search commands' }).click();
    await expect(field).toHaveValue('');
    await win.keyboard.press('Escape');
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
    await expect(sheet.locator('[data-shortcut="find"] dt')).toHaveText('Find in the file');
    await expect(sheet.locator('[data-shortcut="find"] kbd')).toHaveText(mac ? '⌘F' : 'Ctrl+F');
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

/** Every top-level screen and the places within them a person reaches from the bar. */
const SCREENS = ['/today', '/watches', '/watches/calendar', '/watches/people', '/search', '/search/ask', '/search/saved',
  '/search/wording', '/library', '/library/files', '/library/evidence', '/ask', '/health', '/health/watchdog',
  '/health/analytics', '/health/engine', '/settings', '/settings/about', '/settings/ai'];

test('no screen scrolls sideways, from the window\'s 960-pixel minimum up, and the bar gives way rather than spills', async () => {
  test.setTimeout(240_000);
  const { app, win, problems, done } = await launchAtlas('narrow', 960);
  try {
    const minimum = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getMinimumSize());
    expect(minimum?.[0]).toBe(960);
    const trigger = win.getByRole('button', { name: 'New search' });
    const search = win.getByRole('button', { name: 'Search commands' });
    // A real window of each size, as far as the display allows: a runner's screen can be smaller than 1280.
    for (const width of [960, 1024, 1280]) {
      await app.evaluate(({ BrowserWindow }, w) => { BrowserWindow.getAllWindows()[0]?.setSize(w, 768); }, width);
      await expect.poll(() => win.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(width);
      const inner = await win.evaluate(() => window.innerWidth);
      for (const screen of SCREENS) {
        await win.evaluate((s) => { window.location.hash = `#${s}`; }, screen);
        await expect(win.locator('main.stage > *').first()).toBeVisible({ timeout: 30_000 });
        await win.waitForTimeout(250);
        const wide = await win.evaluate(() => document.documentElement.scrollWidth);
        expect(wide, `${screen} at ${inner} pixels scrolls sideways`).toBeLessThanOrEqual(inner);
      }
      // The bar's controls side by side, none over another, all inside the window.
      const boxes = await win.locator('header.bar').evaluate((bar) => [...bar.querySelectorAll('.lockup, .tabs li, .newsearch, .cmdk, .iconbtn')]
        .map((node) => node.getBoundingClientRect()).map((r) => ({ left: r.left, right: r.right })));
      for (let i = 1; i < boxes.length; i += 1) expect(boxes[i]!.left).toBeGreaterThanOrEqual(boxes[i - 1]!.right);
      expect(boxes[boxes.length - 1]!.right).toBeLessThanOrEqual(inner);
      // Narrow, New search is its icon and the command search its icon and keys; both keep their names.
      await expect(trigger).toBeVisible();
      await expect(search).toBeVisible();
      expect(await trigger.locator('.newsearch-label').evaluate((n) => n.getBoundingClientRect().width > 1)).toBe(inner >= 1200);
      expect(await search.locator('.cmdk-label').evaluate((n) => n.getBoundingClientRect().width > 1)).toBe(inner >= 1000);
      if (inner < 1200) {
        fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
        await win.screenshot({ path: path.join(SCREENSHOT_DIR, `atlas-shell-bar-${inner}.png`) });
      }
    }
    // The menu still opens from the icon, inside the window.
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setSize(960, 768); });
    await expect.poll(() => win.evaluate(() => window.innerWidth)).toBe(960);
    await trigger.click();
    const menu = win.getByRole('menu', { name: 'New search' });
    await expect(menu).toBeVisible();
    const box = (await menu.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(960);
    await win.keyboard.press('Escape');
    expect(problems).toEqual([]);
  } finally {
    await done();
  }
});

test('⌘Enter does a field\'s primary action where its button would, and plain Enter is left as it was', async () => {
  test.setTimeout(240_000);
  const { win, problems, done } = await launchAtlas('command-enter');
  try {
    const started: string[] = [];
    win.on('request', (r) => { if (/\/api\/search\/(dive|sweep)$/.test(r.url())) started.push(r.url()); });
    await win.evaluate(() => { window.location.hash = '#/search/ask'; });
    const terms = win.getByLabel('Search terms');
    await expect(win.locator('.source').first()).toBeVisible({ timeout: 30_000 });
    // Plain Enter in the terms still adds a term.
    await terms.fill('perovskite');
    await terms.press('Enter');
    await expect(win.locator('.term', { hasText: 'perovskite' })).toBeVisible();
    // With no source chosen, Ask is disabled, and ⌘Enter does nothing either.
    const ask = win.locator('.ask-go button[type="submit"]');
    await expect(ask).toBeDisabled();
    await terms.fill('tandem');
    await terms.press('ControlOrMeta+Enter');
    await win.waitForTimeout(400);
    await expect(terms).toHaveValue('tandem');
    expect(started).toEqual([]);
    await expect(win.locator('.ask-go .enter-hint')).toHaveText(process.platform === 'darwin' ? '⌘↩' : 'Ctrl+Enter');
    await expect(ask).toHaveAttribute('aria-keyshortcuts', process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await win.locator('.ask-go').screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-shell-command-enter.png') });

    // A saved search's name: ⌘Enter saves it, as Save does, and starts no run, though Ask could.
    await win.locator('.source[data-source="arxiv"] input').check();
    await expect(ask).toBeEnabled();
    await win.locator('[data-saved="keep"]').click();
    await win.locator('#keep-name').fill('Tandems, by the keyboard');
    await win.locator('#keep-name').press('ControlOrMeta+Enter');
    await expect(win.locator('[data-saved="kept"]')).toContainText('Tandems, by the keyboard', { timeout: 30_000 });
    expect(started, '⌘Enter in the name started a run').toEqual([]);
    expect(await win.evaluate(() => window.location.hash)).toBe('#/search/ask');

    // The sheet names it.
    await win.locator('h1').first().click();
    await win.keyboard.press('Shift+Slash');
    const sheet = win.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(sheet.locator('[data-shortcut="command-enter"] dt')).toHaveText('Save or send what you wrote');
    await expect(sheet.locator('[data-shortcut="command-enter"] kbd')).toHaveText(process.platform === 'darwin' ? '⌘↩' : 'Ctrl+Enter');
    await win.keyboard.press('Escape');
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

test('a two-finger swipe goes back and forward, once per swipe, and leaves alone what is not its own', async () => {
  test.setTimeout(240_000);
  const { app, win, problems, done } = await launchAtlas('swipe');
  try {
    // The system's own setting decides, as it does for Safari; unset is on.
    const setting = await app.evaluate(({ systemPreferences }) => (process.platform === 'darwin'
      ? systemPreferences.getUserDefault('AppleEnableSwipeNavigateWithScrolls', 'string') : ''));
    const on = setting !== '0';
    const swipe = async (dx: number, samples = 12, dy = 0) => {
      for (let i = 0; i < samples; i += 1) await win.mouse.wheel(dx, dy);
    };
    const settle = () => win.waitForTimeout(450);
    const arrow = win.locator('.swipe-arrow');
    // The arrow lives only while a swipe does, so what it showed is recorded in
    // the page as it changes, not looked for afterwards, when on a slow machine
    // it may already have gone.
    await win.evaluate(() => {
      const seen: { toward: string | null; swipe: number; transform: string }[] = [];
      (window as unknown as { arrowSeen: typeof seen }).arrowSeen = seen;
      new MutationObserver(() => {
        const node = document.querySelector<HTMLElement>('.swipe-arrow');
        if (node) seen.push({ toward: node.dataset.toward ?? null, swipe: Number(node.style.getPropertyValue('--swipe')), transform: getComputedStyle(node).transform });
      }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'data-toward'] });
    });
    const shown = () => win.evaluate(() => (window as unknown as { arrowSeen: { toward: string | null; swipe: number; transform: string }[] }).arrowSeen.splice(0));

    await win.evaluate(() => { window.location.replace('#/settings'); });
    await expect(win.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible({ timeout: 30_000 });
    const title = win.getByRole('heading', { name: 'Settings', level: 1 });
    const box = (await title.boundingBox())!;
    await win.mouse.move(box.x + box.width + 200, box.y + box.height / 2);

    // No page back: nothing is drawn, nothing happens.
    await swipe(-20);
    await settle();
    expect(await shown()).toEqual([]);
    expect(await hash(win)).toBe('#/settings');

    for (const group of ['about', 'tutorials']) {
      await win.getByRole('navigation', { name: 'Settings groups' }).getByRole('link', { name: group === 'about' ? 'About resmon' : 'Tutorials' }).click();
      await expect.poll(() => hash(win)).toBe(`#/settings/${group}`);
    }
    if (!on) {
      // Two fingers do not move between pages here; three do, through the window's `swipe` event.
      await swipe(-20);
      await settle();
      expect(await hash(win)).toBe('#/settings/tutorials');
      console.log('SWIPE — two-finger swipe navigation is off in System Settings; checked that nothing moved');
      return;
    }

    // — back: the arrow at the left edge grows, then it goes, once, however long the tail ------
    await swipe(-20, 4);
    const growing = await shown();
    expect(growing.length).toBeGreaterThan(0);
    expect(growing.every((state) => state.toward === 'back' && state.swipe > 0 && state.swipe < 1)).toBe(true);
    expect(growing.map((state) => state.swipe)).toEqual([...growing.map((state) => state.swipe)].sort((a, b) => a - b));
    await swipe(-20, 6);
    await expect.poll(() => hash(win)).toBe('#/settings/about');
    // A three-finger `swipe` arriving just after is the same gesture, not a second.
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.emit('swipe', {}, 'left'); });
    // The momentum tail, still arriving after the swipe went.
    for (const dx of [-30, -25, -20, -16, -12, -9, -6, -4, -3, -2, -1]) await win.mouse.wheel(dx, 0);
    await settle();
    expect(await hash(win)).toBe('#/settings/about');
    await expect(arrow).toHaveCount(0);

    // — forward ---------------------------------------------------------------------------
    await swipe(20);
    await expect.poll(() => hash(win)).toBe('#/settings/tutorials');
    await settle();

    // — up and down is scrolling --------------------------------------------------------
    await swipe(-6, 12, 30);
    await settle();
    expect(await hash(win)).toBe('#/settings/tutorials');

    // — a box that can still scroll that way takes the swipe; at its edge, the page does ----------
    await win.evaluate(() => {
      const strip = document.createElement('div');
      strip.id = 'e2e-strip';
      Object.assign(strip.style, { position: 'fixed', left: '40px', bottom: '40px', width: '300px', height: '80px', overflowX: 'auto', zIndex: '9' });
      strip.innerHTML = '<div style="width: 1200px; height: 60px"></div>';
      document.body.append(strip);
      strip.scrollLeft = 300;
    });
    const strip = (await win.locator('#e2e-strip').boundingBox())!;
    await win.mouse.move(strip.x + 150, strip.y + 40);
    await swipe(-20, 6);
    await settle();
    expect(await hash(win)).toBe('#/settings/tutorials');
    expect(await win.locator('#e2e-strip').evaluate((node) => node.scrollLeft)).toBeLessThan(300);
    await win.locator('#e2e-strip').evaluate((node) => { node.scrollLeft = 0; });
    await swipe(-20);
    await expect.poll(() => hash(win)).toBe('#/settings/about');
    await win.evaluate(() => document.getElementById('e2e-strip')?.remove());
    await settle();

    // — a text field keeps its swipe ----------------------------------------------------
    await win.evaluate(() => { window.location.hash = '#/search/ask'; });
    const terms = win.getByLabel('Search terms');
    const field = (await terms.boundingBox())!;
    await win.mouse.move(field.x + 40, field.y + field.height / 2);
    await swipe(-20);
    await settle();
    expect(await hash(win)).toBe('#/search/ask');

    // — with reduced motion, the arrow does not slide -------------------------------------
    await win.emulateMedia({ reducedMotion: 'reduce' });
    const heading = (await win.getByRole('heading', { name: 'Ask the sources', level: 1 }).boundingBox())!;
    await win.mouse.move(heading.x + heading.width / 2, heading.y + heading.height / 2);
    await shown();
    await swipe(-20, 3);
    await settle();
    const still = await shown();
    expect(still.length).toBeGreaterThan(0);
    expect(still.every((state) => state.toward === 'back' && state.transform === 'none')).toBe(true);
    await win.emulateMedia({ reducedMotion: null });
    console.log('SWIPE — back and forward once per swipe; tail, vertical, scrollable strip, text field and three-finger repeat left alone');
    expect(problems).toEqual([]);
  } finally {
    await done();
  }
});
