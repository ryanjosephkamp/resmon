import { test, expect, SCREENSHOT_DIR } from './fixtures/resmon-app';
import * as path from 'path';
import * as fs from 'fs';

test('the header clears the window buttons and contains its controls throughout View zoom', async ({ app, win, goto }) => {
  await goto('/today');
  const id = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].id);
  // The shared window is put back as it was found, not at a size written here: on a display smaller
  // than the suite's request (CI's macOS runner) it is narrower than 1440, and the specs after this
  // one measure it against the display.
  const found = await app.evaluate(({ BrowserWindow }, id) => {
    const window = BrowserWindow.fromId(id)!;
    return { bounds: window.getBounds(), zoom: window.webContents.getZoomFactor() };
  }, id);
  try {
    for (const size of [[960, 640], [1440, 900]]) {
      await app.evaluate(({ BrowserWindow }, { id, size }) => {
        const window = BrowserWindow.fromId(id)!;
        window.unmaximize();
        window.setSize(size[0], size[1]);
      }, { id, size });
      // Chromium's preset zoom factors, including the endpoints of View's range.
      for (const zoom of [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5]) {
        await app.evaluate(({ BrowserWindow }, { id, zoom }) => BrowserWindow.fromId(id)!.webContents.setZoomFactor(zoom), { id, zoom });
        await win.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        const problems = await win.evaluate(({ zoom, mac }) => {
          const bar = document.querySelector('.bar')!;
          const bad: string[] = [];
          const items = [...bar.querySelectorAll<HTMLElement>(':scope > a, :scope > button, :scope > nav, :scope > .scope')]
            .filter(element => element.getBoundingClientRect().width > 1);
          for (const item of items) {
            const box = item.getBoundingClientRect();
            if (box.left < (mac ? 78 / zoom : 0) - 1 || box.right > innerWidth + 1) bad.push(`${item.className}: outside bar ${box.left},${box.right}`);
          }
          const command = bar.querySelector('.cmdk')!;
          const box = command.getBoundingClientRect();
          for (const child of command.children) {
            const rect = child.getBoundingClientRect();
            if (rect.width > 1 && (rect.left < box.left - 1 || rect.right > box.right + 1)) bad.push(`command child outside: ${child.tagName}`);
          }
          return bad;
        }, { zoom, mac: process.platform === 'darwin' });
        expect(problems, `${size.join('×')} at ${zoom}`).toEqual([]);
        if (size[0] === 960 && [0.5, 1.25, 5].includes(zoom)) {
          const png = await app.evaluate(async ({ BrowserWindow }, id) => (await BrowserWindow.fromId(id)!.capturePage()).toPNG().toString('base64'), id);
          fs.writeFileSync(path.join(SCREENSHOT_DIR, `header-zoom-${zoom}.png`), Buffer.from(png, 'base64'));
        }
      }
    }
  } finally {
    await app.evaluate(({ BrowserWindow }, { id, found }) => {
      const window = BrowserWindow.fromId(id)!;
      window.webContents.setZoomFactor(found.zoom);
      window.setBounds(found.bounds);
    }, { id, found });
  }
});
