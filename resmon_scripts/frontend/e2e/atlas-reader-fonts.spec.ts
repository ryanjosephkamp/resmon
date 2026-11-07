/** Embedded Type 1 math must reach Chromium as the PDF's own loaded faces. */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { FRONTEND_ROOT, atlasEnv, launchEnv, registerStateDir } from './fixtures/resmon-app';
import { removeStateDir } from './fixtures/cleanup';

test('embedded math fonts draw in the cover, reader, and page gallery without substitution', async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-fonts-'));
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-fonts-library-')));
  registerStateDir(state);
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({
      args: ['.', `--user-data-dir=${path.join(state, 'profile')}`], cwd: FRONTEND_ROOT,
      env: atlasEnv(launchEnv(state, true)), colorScheme: null, timeout: 180_000,
    });
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    }, parent);
    const win = await app.firstWindow();
    const messages: string[] = [];
    win.on('console', (message) => messages.push(`${message.type()}: ${message.text()}`));
    const external: string[] = [];
    await app.context().route(/https?:\/\//, async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname === '127.0.0.1' && url.port !== '8742') return route.continue();
      external.push(url.href);
      return route.abort();
    });
    await expect(win.getByRole('navigation', { name: 'Sections' })).toBeVisible({ timeout: 120_000 });
    await win.evaluate(() => {
      const violations: string[] = [];
      Object.assign(window, { fontViolations: violations });
      document.addEventListener('securitypolicyviolation', (event) => {
        violations.push(`${event.effectiveDirective}: ${event.blockedURI}`);
      });
      window.location.hash = '#/library?show=files';
    });
    await win.getByRole('button', { name: 'Choose parent folder' }).click();
    await win.getByRole('button', { name: 'Create the library here' }).click();
    await win.getByLabel('Import PDF, TXT, MD, or TeX').setInputFiles(path.join(__dirname, 'fixtures', 'math-embedded.pdf'));
    const card = win.locator('article[data-file]').filter({ hasText: 'math-embedded.pdf' });
    await expect(card.locator('img')).toBeVisible({ timeout: 60_000 });
    await card.getByRole('button', { name: 'Read', exact: true }).click();
    const reader = win.getByRole('region', { name: 'PDF reader' });
    const sheet = reader.locator('.ev-sheet[data-page="1"][data-drawn="true"]');
    await expect(sheet).toBeVisible({ timeout: 60_000 });
    const text = await sheet.locator('.textLayer').innerText();
    await reader.getByRole('button', { name: 'All pages' }).click();
    await expect(reader.locator('button.ev-thumb img').first()).toBeVisible({ timeout: 30_000 });
    await reader.locator('button.ev-thumb[data-page="1"]').click();
    await expect(sheet).toBeVisible();
    const faces = await win.evaluate(() => Array.from(document.fonts)
      .filter((font) => /^g_d\d+_f/.test(font.family)).map((font) => ({ family: font.family, status: font.status })));
    const violations = await win.evaluate(() => (window as unknown as { fontViolations: string[] }).fontViolations);
    console.log('[embedded-fonts]', JSON.stringify({ faces, violations, messages }));
    await test.info().attach('font-diagnostics', { body: JSON.stringify({ faces, violations, messages }, null, 2), contentType: 'application/json' });
    if (process.env.RESMON_FONT_EVIDENCE) {
      await win.screenshot({ path: `${process.env.RESMON_FONT_EVIDENCE}.png` });
      fs.writeFileSync(`${process.env.RESMON_FONT_EVIDENCE}.json`, JSON.stringify({ faces, violations, messages }, null, 2));
    }
    expect(violations).toEqual([]);
    expect(messages.filter((message) => /warning:|Failed to load font|OTS parsing|Refused to/i.test(message))).toEqual([]);
    expect(faces.length).toBeGreaterThanOrEqual(10);
    expect(faces.every((font) => font.status === 'loaded')).toBe(true);
    expect(external).toEqual([]);
    for (const glyph of ['δ', '∈', '⊤']) expect(text).toContain(glyph);
  } finally {
    await app?.close().catch(() => undefined);
    removeStateDir(state);
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
