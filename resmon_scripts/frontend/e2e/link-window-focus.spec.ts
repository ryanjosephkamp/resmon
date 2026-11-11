import { createServer } from 'http';
import { test, expect } from './fixtures/resmon-app';

/**
 * One reading for `expect.poll`. V8 can collect the promise of a main-process
 * evaluation while it is awaited, which Playwright reports as "Resulting promise
 * was garbage collected"; that reading is taken again rather than failing the
 * poll at once. Any other error still fails it.
 */
async function reading<T>(evaluate: () => Promise<T>): Promise<T | undefined> {
  try {
    return await evaluate();
  } catch (error) {
    if (error instanceof Error && error.message.includes('Resulting promise was garbage collected')) return undefined;
    throw error;
  }
}

test('clicking a covered link page brings its independent window forward', async ({ app, win }) => {
  const server = createServer((_request, response) => response.end('<h1>Link page</h1>'));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing loopback port');
  const urls = ['first', 'second'].map(name => `http://127.0.0.1:${address.port}/${name}`);
  const mainId = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].id);
  try {
    for (const url of urls) await win.evaluate(target => { window.open(target); }, url);
    await expect.poll(() => reading(() => app.evaluate(({ webContents }, targets) => targets.every(target =>
      webContents.getAllWebContents().some(contents => contents.getURL() === target && !contents.isLoading())), urls))).toBe(true);
    const facts = await app.evaluate(async ({ app: application, BrowserWindow, webContents }, targets) => {
      const windows = targets.map(target => BrowserWindow.getAllWindows().find(window => window.getTitle() === target)!);
      application.focus({ steal: true });
      windows[1].focus();
      const first = webContents.getAllWebContents().find(contents => contents.getURL() === targets[0])!;
      return { parents: windows.map(window => window.getParentWindow()?.id ?? null),
        id: windows[0].id, covering: windows[1].id, page: first.id };
    }, urls);
    await expect.poll(() => reading(() => app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.isFocused(), facts.covering))).toBe(true);
    await app.evaluate(({ webContents }, id) => {
      const first = webContents.fromId(id)!;
      first.sendInputEvent({ type: 'mouseDown', x: 200, y: 100, button: 'left', clickCount: 1 });
      first.sendInputEvent({ type: 'mouseUp', x: 200, y: 100, button: 'left', clickCount: 1 });
    }, facts.page);
    await expect.poll(() => reading(() => app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.isFocused(), facts.id))).toBe(true);
    expect(facts.parents).toEqual([null, null]);
  } finally {
    await app.evaluate(({ BrowserWindow }, keep) => {
      for (const window of BrowserWindow.getAllWindows()) if (window.id !== keep) window.destroy();
    }, mainId);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
