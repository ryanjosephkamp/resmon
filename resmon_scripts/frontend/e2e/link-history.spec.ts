import { createServer } from 'http';
import { test, expect } from './fixtures/resmon-app';

test('the front link window owns menu, keyboard, and two-finger history', async ({ app, win, goto }) => {
  await goto('/health/watchdog');
  const server = createServer((_request, response) => response.end('<h1>History</h1>'));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing loopback port');
  const first = `http://127.0.0.1:${address.port}/one`;
  const second = `http://127.0.0.1:${address.port}/two`;
  const mainId = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].id);
  const mainUrl = win.url();
  try {
    await win.evaluate(target => { window.open(target); }, first);
    await expect.poll(() => app.evaluate(({ webContents }, target) =>
      webContents.getAllWebContents().some(contents => contents.getURL() === target && !contents.isLoading()), first)).toBe(true);
    const ids = await app.evaluate(({ BrowserWindow, webContents }, { target, keep }) => ({
      window: BrowserWindow.getAllWindows().find(window => window.id !== keep)!.id,
      page: webContents.getAllWebContents().find(contents => contents.getURL() === target)!.id,
    }), { target: first, keep: mainId });
    const at = (target: string) => expect.poll(() => app.evaluate(({ webContents }, id) => webContents.fromId(id)?.getURL(), ids.page)).toBe(target);
    await app.evaluate(async ({ webContents }, { id, url }) => { await webContents.fromId(id)!.loadURL(url); }, { id: ids.page, url: second });
    await app.evaluate(({ app: application, BrowserWindow }, id) => {
      application.focus({ steal: true });
      BrowserWindow.fromId(id)!.focus();
    }, ids.window);
    await expect.poll(() => app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getFocusedWindow()?.id === id, ids.window)).toBe(true);
    await app.evaluate(({ Menu }) => { Menu.getApplicationMenu()!.getMenuItemById('history-back')!.click(); });
    await at(first);
    for (const [key, target] of [['Right', second], ['[', first], [']', second], ['Left', first]]) {
      await app.evaluate(({ webContents }, { id, key }) => {
        webContents.fromId(id)!.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers: [process.platform === 'darwin' ? 'meta' : 'alt'] });
      }, { id: ids.page, key });
      await at(target);
    }
    await app.evaluate(({ webContents }, id) => webContents.fromId(id)!.executeJavaScript(`
      window.dispatchEvent(new WheelEvent('wheel', { deltaX: 80, deltaY: 1 }));
      window.dispatchEvent(new WheelEvent('wheel', { deltaX: 80, deltaY: 1 }));
    `), ids.page);
    await at(second);
    // A tail and the native swipe from the same gesture cannot move twice.
    await app.evaluate(({ BrowserWindow }, id) => { BrowserWindow.fromId(id)!.emit('swipe', {}, 'left'); }, ids.window);
    await at(second);
    expect(win.url()).toBe(mainUrl);
  } finally {
    await app.evaluate(({ BrowserWindow }, keep) => {
      for (const window of BrowserWindow.getAllWindows()) if (window.id !== keep) window.destroy();
    }, mainId);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
