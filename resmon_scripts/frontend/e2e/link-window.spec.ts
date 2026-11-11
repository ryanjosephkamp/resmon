import { createServer, type ServerResponse } from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { test, expect, SCREENSHOT_DIR } from './fixtures/resmon-app';

test('a stalled link draws its loading bar within three seconds and opens the same address in the browser', async ({ app, win }) => {
  let pending: ServerResponse | undefined;
  const server = createServer((_request, response) => { pending = response; });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing loopback port');
  const url = `http://127.0.0.1:${address.port}/stalled`;
  const mainId = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].id);
  const opened = await app.evaluateHandle(({ shell }) => {
    const addresses: string[] = [];
    shell.openExternal = async target => { addresses.push(target); };
    return addresses;
  });
  try {
    const started = Date.now();
    await win.evaluate(target => { window.open(target); }, url);
    await expect.poll(() => app.evaluate(({ BrowserWindow }, keep) =>
      BrowserWindow.getAllWindows().find(window => window.id !== keep)?.isVisible() ?? false,
    mainId), { timeout: 3000, intervals: [20, 50, 100] }).toBe(true);
    const link = app.windows().find(page => page !== win && page.url().startsWith('data:text/html'));
    if (!link) throw new Error('missing link window');
    await expect(link.getByText('Loading the page…', { exact: true })).toBeVisible({ timeout: Math.max(1, 3000 - (Date.now() - started)) });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(await link.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
    expect(await link.evaluate(() => {
      const luminance = (color: string) => {
        const channels = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(value => value / 255)
          .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
        return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
      };
      const text = luminance(getComputedStyle(document.getElementById('status')!).color);
      const background = luminance(getComputedStyle(document.body).backgroundColor);
      return (Math.max(text, background) + 0.05) / (Math.min(text, background) + 0.05);
    })).toBeGreaterThanOrEqual(4.5);
    const png = await app.evaluate(async ({ BrowserWindow }, keep) =>
      (await BrowserWindow.getAllWindows().find(window => window.id !== keep)!.capturePage()).toPNG().toString('base64'), mainId);
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    fs.writeFileSync(path.join(SCREENSHOT_DIR, 'link-window-loading.png'), Buffer.from(png, 'base64'));
    await expect(link.getByRole('textbox', { name: 'Address' })).toHaveValue(url);
    await link.getByRole('button', { name: 'Open in Your Browser', exact: true }).click();
    await expect.poll(() => opened.jsonValue()).toEqual([url]);
    pending?.end('<h1>Loaded</h1>');
    await expect(link.getByText('Loading the page…', { exact: true })).toHaveCount(0);
    console.log('LINK WINDOW DRAW', Date.now() - started, 'ms including browser-button check');
    expect(await app.evaluate(async ({ webContents }, target) => {
      const remote = webContents.getAllWebContents().find(contents => contents.getURL() === target);
      return remote?.executeJavaScript('({ bridge: typeof window.resmonAPI, node: typeof require })');
    }, url)).toEqual({ bridge: 'undefined', node: 'undefined' });
  } finally {
    pending?.end();
    await app.evaluate(({ BrowserWindow }, keep) => {
      for (const window of BrowserWindow.getAllWindows()) if (window.id !== keep) window.destroy();
    }, mainId);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await opened.dispose();
  }
});
