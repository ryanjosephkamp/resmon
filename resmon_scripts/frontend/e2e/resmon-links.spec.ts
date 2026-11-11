/**
 * `resmon://` links in the real app (`electron/resmonLinks.ts`): macOS hands
 * one over as `open-url`, and Windows and Linux as a second launch's
 * arguments. Either opens Look Up a Paper with the paper filled in and its page
 * named, and asks no source anything; a link resmon does not answer changes
 * nothing. The events are raised as the system raises them.
 */
import { test, expect, ATLAS_LANDMARK } from './fixtures/resmon-app';

const NATURE = 'https://www.nature.com/articles/nphys1170';

test('a resmon:// link opens Look Up a Paper filled in and asks nothing; any other link is ignored', async ({ app, win, goto }) => {
  await expect(win.locator(ATLAS_LANDMARK)).toBeVisible({ timeout: 60_000 });
  await goto('/library');
  const asked: string[] = [];
  win.on('request', (request) => { if (request.method() === 'POST' && /\/api\/find\b/.test(request.url())) asked.push(request.url()); });
  const windows = app.windows().length;

  // Refused: another action, nothing to look up, another scheme.
  for (const link of ['resmon://settings', 'resmon://find', 'resmon://find/settings?q=x', 'https://find?q=x']) {
    await app.evaluate(({ app: electron }, url) => { electron.emit('open-url', { preventDefault() { /* the system's event */ } }, url); }, link);
  }
  expect(new URL(win.url()).hash).toBe('#/library');
  await app.evaluate(({ app: electron }, url) => { electron.emit('open-url', { preventDefault() { /* the system's event */ } }, url); },
    `resmon://find?q=10.1038%2Fnphys1170&from=${encodeURIComponent(NATURE)}`);
  await expect.poll(() => new URL(win.url()).hash).toMatch(/^#\/search\/find\?/);
  const opened = new URLSearchParams(new URL(win.url()).hash.split('?')[1]);
  expect([opened.get('q'), opened.get('from')]).toEqual(['10.1038/nphys1170', NATURE]);
  await expect(win.locator('[data-find="query"]')).toHaveValue('10.1038/nphys1170');
  await expect(win.locator('[data-find="from"]')).toContainText(`It names the page it came from: ${NATURE}.`);
  await expect(win.locator('[data-find="reads"]')).toContainText('Reads as a DOI');

  // Windows and Linux: a second launch with the link among its arguments hands it here.
  await app.evaluate(({ app: electron }, url) => { electron.emit('second-instance', {}, ['resmon', '--no-sandbox', url], ''); },
    'resmon://find?q=Attention%20Is%20All%20You%20Need');
  await expect(win.locator('[data-find="query"]')).toHaveValue('Attention Is All You Need');
  await expect(win.locator('[data-find="from"]')).not.toContainText('It names the page');
  // The same link again, after typing, fills the field again.
  await win.locator('[data-find="query"]').fill('typed meanwhile');
  await app.evaluate(({ app: electron }, url) => { electron.emit('second-instance', {}, ['resmon', url], ''); },
    'resmon://find?q=Attention%20Is%20All%20You%20Need');
  await expect(win.locator('[data-find="query"]')).toHaveValue('Attention Is All You Need');
  // macOS: a launch that found this resmon already running hands its link over with the lock.
  await app.evaluate(({ app: electron }, url) => { electron.emit('second-instance', {}, ['resmon'], '', { resmonLink: url }); },
    'resmon://find?q=PMID%3A17375194');
  await expect(win.locator('[data-find="query"]')).toHaveValue('PMID:17375194');

  // Nothing was asked of a source, and no window was opened for it.
  expect(asked).toEqual([]);
  expect(app.windows().length).toBe(windows);
});
