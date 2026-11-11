/**
 * resmon's browser, in the real app: the link window's bar (its address
 * field, Back, Forward, and Reload), a search typed into it, and Settings ›
 * Links deciding where a followed link opens: resmon's browser or yours, and,
 * on macOS, a tab of resmon's browser.
 *
 * Every page is served on loopback. A search's address is canceled before it
 * leaves this machine, as `main-window.spec.ts` cancels its link.
 */
import { createServer } from 'http';
import type { ElectronApplication, Page } from '@playwright/test';
import { test, expect } from './fixtures/resmon-app';

type Links = { open_in: string; new: string; search: string };

const linksNow = (app: ElectronApplication) =>
  app.evaluate(() => (globalThis as { resmonWebLinks?: Links }).resmonWebLinks ?? null);

const otherWindows = (app: ElectronApplication, keep: number) =>
  app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows().filter((w) => w.id !== id && !w.isDestroyed())
    .map((w) => ({ id: w.id, title: w.getTitle(), bounds: w.getBounds() })), keep);

async function newestBar(app: ElectronApplication, known: Set<Page>): Promise<Page> {
  let found: Page | undefined;
  await expect.poll(() => {
    found = app.windows().find((page) => !known.has(page) && page.url().startsWith('data:text/html'));
    return Boolean(found);
  }).toBe(true);
  known.add(found!);
  return found!;
}

test("resmon's browser: the address field, Back, Forward, Reload, a search, and where Settings › Links opens a link", async ({ app, win, goto }) => {
  const hits: string[] = [];
  const server = createServer((request, response) => {
    hits.push(request.url ?? '');
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(`<title>Page ${request.url}</title><h1>${request.url}</h1>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing loopback port');
  const base = `http://127.0.0.1:${address.port}`;
  const mainId = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].id);
  const searches = await app.evaluateHandle(({ session }) => {
    const seen: string[] = [];
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ['https://duckduckgo.com/*', 'https://scholar.google.com/*'] },
      (details, callback) => { seen.push(details.url); callback({ cancel: true }); },
    );
    return seen;
  });
  const opened = await app.evaluateHandle(({ shell }) => {
    const addresses: string[] = [];
    shell.openExternal = async (target) => { addresses.push(target); };
    return addresses;
  });
  const bars = new Set<Page>();
  try {
    // — Settings › Links is read from the engine and handed to the main process ---------------
    await goto('/settings/links');
    await expect.poll(() => linksNow(app)).toEqual({ open_in: 'resmon', new: 'window', search: 'duckduckgo' });
    await expect(win.getByRole('radio', { name: 'resmon’s Browser' })).toBeChecked();

    // — a link opens in a window of resmon's browser, its address in the bar ------------------
    await win.evaluate((target) => { window.open(target); }, `${base}/one`);
    const bar = await newestBar(app, bars);
    const field = bar.getByRole('textbox', { name: 'Address' });
    const back = bar.getByRole('button', { name: 'Back' });
    const forward = bar.getByRole('button', { name: 'Forward' });
    await expect(field).toHaveValue(`${base}/one`);
    await expect(back).toBeDisabled();
    await expect(forward).toBeDisabled();
    // The page's title names the window, and its tab on macOS.
    await expect.poll(async () => (await otherWindows(app, mainId)).map((w) => w.title)).toEqual(['Page /one']);

    // — an address typed without its scheme, then Back and Forward ------------------------------
    await field.fill(`127.0.0.1:${address.port}/two`);
    await field.press('Enter');
    await expect(field).toHaveValue(`${base}/two`);
    await expect(back).toBeEnabled();
    await back.click();
    await expect(field).toHaveValue(`${base}/one`);
    await expect(forward).toBeEnabled();
    await forward.click();
    await expect(field).toHaveValue(`${base}/two`);

    // — Reload asks the page's host again ----------------------------------------------------
    const asked = hits.length;
    await bar.getByRole('button', { name: 'Reload' }).click();
    await expect.poll(() => hits.length).toBe(asked + 1);
    expect(hits[hits.length - 1]).toBe('/two');

    // — Escape puts back the address an edit replaced -----------------------------------------
    await field.fill('half typed');
    await field.press('Escape');
    await expect(field).toHaveValue(`${base}/two`);

    // — words are searched for with the chosen search -----------------------------------------
    await expect(field).toHaveAttribute('placeholder', 'Search with DuckDuckGo or type an address');
    await field.fill('graph neural networks');
    await field.press('Enter');
    await expect.poll(() => searches.jsonValue()).toEqual(['https://duckduckgo.com/?q=graph%20neural%20networks']);
    await win.getByRole('combobox', { name: /^Search from the address field with/ }).selectOption('google_scholar');
    await expect.poll(async () => (await linksNow(app))?.search).toBe('google_scholar');
    await expect(field).toHaveAttribute('placeholder', 'Search with Google Scholar or type an address');
    await field.fill('protein folding');
    await field.press('Enter');
    await expect.poll(async () => (await searches.jsonValue()).slice(-1)[0]).toBe('https://scholar.google.com/scholar?q=protein%20folding');

    // — your own browser: a followed link goes there, and no window opens ---------------------
    await win.getByRole('radio', { name: /^Your Default Browser/ }).check();
    await expect.poll(async () => (await linksNow(app))?.open_in).toBe('browser');
    const before = (await otherWindows(app, mainId)).length;
    await win.evaluate((target) => { window.open(target); }, `${base}/three`);
    await expect.poll(() => opened.jsonValue()).toEqual([`${base}/three`]);
    expect((await otherWindows(app, mainId)).length).toBe(before);
    await win.getByRole('radio', { name: 'resmon’s Browser' }).check();
    await expect.poll(async () => (await linksNow(app))?.open_in).toBe('resmon');

    // — macOS: a link as a tab of resmon's browser, and ⌘T's empty tab there --------------------
    if (process.platform === 'darwin') {
      const [first] = await otherWindows(app, mainId);
      // Moved off center, so a tab taking the group's frame is told from a new window, which is centered.
      await app.evaluate(({ BrowserWindow }, id) => { BrowserWindow.fromId(id)!.setBounds({ x: 40, y: 60, width: 900, height: 700 }); }, first.id);
      await win.getByRole('radio', { name: 'A New Tab' }).check();
      await expect.poll(async () => (await linksNow(app))?.new).toBe('tab');
      await win.evaluate((target) => { window.open(target); }, `${base}/four`);
      await newestBar(app, bars);
      await expect.poll(async () => (await otherWindows(app, mainId)).length).toBe(2);
      await expect.poll(async () => new Set((await otherWindows(app, mainId)).map((w) => JSON.stringify(w.bounds))).size).toBe(1);
      await app.evaluate(({ Menu, BrowserWindow }, id) => {
        Menu.getApplicationMenu()!.getMenuItemById('file-new-tab')!.click(undefined, BrowserWindow.fromId(id)!);
      }, first.id);
      const empty = await newestBar(app, bars);
      await expect.poll(async () => (await otherWindows(app, mainId)).map((w) => w.title))
        .toEqual(expect.arrayContaining(['New Tab', 'Page /four']));
      expect(await otherWindows(app, mainId)).toHaveLength(3);
      await expect(empty.getByRole('textbox', { name: 'Address' })).toHaveValue('');
      await expect(empty.getByRole('textbox', { name: 'Address' })).toBeFocused();
      await expect.poll(async () => new Set((await otherWindows(app, mainId)).map((w) => JSON.stringify(w.bounds))).size).toBe(1);
      await win.getByRole('radio', { name: 'A New Window' }).check();
      await expect.poll(async () => (await linksNow(app))?.new).toBe('window');
    } else {
      console.log('NOT VERIFIED — tabs of resmon’s browser: only macOS draws window tabs.');
    }
    await win.getByRole('combobox', { name: /^Search from the address field with/ }).selectOption('duckduckgo');
    await expect.poll(async () => (await linksNow(app))?.search).toBe('duckduckgo');
  } finally {
    await app.evaluate(({ session }) => { session.defaultSession.webRequest.onBeforeRequest(null); });
    await app.evaluate(({ BrowserWindow }, keep) => {
      for (const window of BrowserWindow.getAllWindows()) if (window.id !== keep) window.destroy();
    }, mainId);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await searches.dispose();
    await opened.dispose();
  }
});
