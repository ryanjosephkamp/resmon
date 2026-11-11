/**
 * Right-click menus in the real app. A native menu can't be clicked from a
 * test, so under e2e the main process keeps the menu it built
 * (`globalThis.resmonContextMenu`) instead of showing it; this spec raises the
 * window's `context-menu` event as a right-click would, reads that menu, and
 * clicks its items. What each kind of click offers is unit tested in
 * `tests/electronContextMenu.test.ts`; this checks the wiring.
 */
import type { ElectronApplication, Page } from '@playwright/test';
import { test, expect, ATLAS_LANDMARK } from './fixtures/resmon-app';

const NO_EDIT = { canUndo: false, canRedo: false, canCut: false, canCopy: false, canPaste: false, canSelectAll: false, canEditRichly: false, canDelete: false };
const mac = process.platform === 'darwin';

interface Click { linkURL?: string; selectionText?: string; isEditable?: boolean; editFlags?: Partial<typeof NO_EDIT> }

/** Raises a right-click on `page`'s window and returns the menu's labels (— for a separator). */
async function rightClick(app: ElectronApplication, page: Page, click: Click): Promise<string[]> {
  const window = await app.browserWindow(page);
  await app.evaluate(() => { (globalThis as { resmonContextMenu?: unknown }).resmonContextMenu = undefined; });
  await window.evaluate((w, params) => {
    w.webContents.emit('context-menu', { preventDefault() { /* a test's event */ } }, params);
  }, {
    linkURL: '', selectionText: '', isEditable: false, misspelledWord: '', dictionarySuggestions: [],
    ...click, editFlags: { ...NO_EDIT, ...(click.editFlags ?? {}) },
  });
  return app.evaluate(() => {
    const menu = (globalThis as { resmonContextMenu?: Electron.Menu }).resmonContextMenu;
    return menu ? menu.items.map((item) => (item.type === 'separator' ? '—' : item.label)) : [];
  });
}

function clickItem(app: ElectronApplication, label: string): Promise<void> {
  return app.evaluate((_electron, which) => {
    const menu = (globalThis as { resmonContextMenu?: Electron.Menu }).resmonContextMenu;
    const item = menu?.items.find((i) => i.label === which);
    if (!item) throw new Error(`no menu item ${which}`);
    item.click();
  }, label);
}

test('right-click menus: a resmon link, a web link with its DOI, a selection, a field, and a plain spot', async ({ app, win }) => {
  await expect(win.locator(ATLAS_LANDMARK)).toBeVisible({ timeout: 60_000 });
  const origin = new URL(win.url()).origin;

  // A plain spot: no menu at all.
  expect(await rightClick(app, win, {})).toEqual([]);

  // A link to one of resmon's own pages opens there in a new window.
  expect(await rightClick(app, win, { linkURL: `${origin}/#/settings` }))
    .toEqual(mac ? ['Open in New Window', 'Open in New Tab'] : ['Open in New Window']);
  const before = app.windows().length;
  const opened = app.waitForEvent('window');
  await clickItem(app, 'Open in New Window');
  const second = await opened;
  await expect.poll(() => second.url()).toContain('#/settings');
  expect(app.windows().length).toBe(before + 1);
  await second.close();

  // A link to a paper's page can also save it to read. No paper 987654 is in
  // this collection, so the window says the engine refused: the whole round
  // trip, from the menu through the window's page and the engine to its notice.
  expect(await rightClick(app, win, { linkURL: `${origin}/#/papers/987654` }))
    .toEqual([...(mac ? ['Open in New Window', 'Open in New Tab'] : ['Open in New Window']), '—', 'Save to Read']);
  await clickItem(app, 'Save to Read');
  await expect(win.locator('.lib-notice')).toContainText('The paper could not be saved to read');

  // A doi.org link: resmon's browser, yours, the link, and the DOI. The
  // clipboard is put back as it was.
  // On macOS, a tab of resmon's browser too.
  expect(await rightClick(app, win, { linkURL: 'https://doi.org/10.1371/journal.pone.0000308' })).toEqual([
    'Open Link in New Window', ...(process.platform === 'darwin' ? ['Open Link in New Tab'] : []),
    'Open Link in Your Browser', 'Copy Link', 'Copy DOI',
  ]);
  const held = await app.evaluate(({ clipboard }) => clipboard.readText());
  try {
    await clickItem(app, 'Copy DOI');
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe('10.1371/journal.pone.0000308');
  } finally {
    await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), held);
  }

  // A selection, and a field.
  expect(await rightClick(app, win, { selectionText: 'tidal dissipation' }))
    .toEqual(mac ? ['Copy', 'Look Up “tidal dissipation”'] : ['Copy']);
  expect(await rightClick(app, win, { isEditable: true, editFlags: { canPaste: true, canSelectAll: true } }))
    .toEqual(['Undo', 'Redo', '—', 'Cut', 'Copy', 'Paste', 'Select All']);
});
