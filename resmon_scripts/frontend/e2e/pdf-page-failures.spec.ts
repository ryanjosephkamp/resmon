import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test, expect, _electron as electron } from '@playwright/test';
import { FRONTEND_ROOT, REPO_ROOT, SCREENSHOT_DIR, atlasEnv, launchEnv, registerStateDir } from './fixtures/resmon-app';
import { removeStateDir } from './fixtures/cleanup';

const PDF = path.join(REPO_ROOT, 'resmon_scripts/verification_scripts/fixtures/evidence/piwowar-2007.pdf');

test('the five-page CFF paper draws in Library and Evidence while canonical text is refused per page', async () => {
  test.setTimeout(240_000);
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-pdf-failures-'));
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-pdf-failures-library-')));
  registerStateDir(state);
  const app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(state, 'profile')}`],
    cwd: FRONTEND_ROOT, env: atlasEnv(launchEnv(state, true)), colorScheme: null, timeout: 180_000 });
  try {
    await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, parent);
    const win = await app.firstWindow();
    const messages: string[] = [];
    win.on('console', (message) => messages.push(`${message.type()}: ${message.text()}`));
    win.on('pageerror', (error) => messages.push(error.message));
    await expect(win.getByRole('navigation', { name: 'Sections' })).toBeVisible({ timeout: 120_000 });
    await win.evaluate(() => { window.location.hash = '#/library?show=files'; });
    await win.getByRole('button', { name: 'Choose Parent Folder' }).click();
    await win.getByRole('button', { name: 'Create the Library Here' }).click();
    await win.getByLabel('Import PDF, TXT, MD, or TeX').setInputFiles(PDF);
    const card = win.locator('article[data-file]').filter({ hasText: 'piwowar-2007.pdf' });
    await expect(card.locator('img')).toBeVisible({ timeout: 30_000 });
    const coverInk = await card.locator('img').evaluate((img: HTMLImageElement) => {
      const canvas = document.createElement('canvas'); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
      const context = canvas.getContext('2d')!; context.drawImage(img, 0, 0);
      const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let ink = 0; for (let i = 0; i < data.length; i += 16) if (data[i]! < 200) ink++;
      return ink;
    });
    expect(coverInk).toBeGreaterThan(100);
    await card.getByRole('button', { name: 'Read', exact: true }).click();
    const reader = win.getByRole('region', { name: 'PDF reader' });
    for (let page = 1; page <= 5; page++) {
      const input = reader.getByRole('textbox', { name: 'Page', exact: true });
      await input.fill(String(page)); await input.press('Enter');
      const sheet = reader.locator(`.ev-sheet[data-page="${page}"][data-drawn="true"]`);
      await expect(sheet).toBeVisible({ timeout: 45_000 });
      const ink = await sheet.locator('canvas').evaluate((canvas: HTMLCanvasElement) => {
        const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
        let dark = 0;
        for (let i = 0; i < pixels.length; i += 16) if (pixels[i]! < 200 && pixels[i + 1]! < 200 && pixels[i + 2]! < 200) dark++;
        return dark;
      });
      console.log('[pdf-page]', JSON.stringify({ page, ink, messages, textLength: (await sheet.locator('.textLayer').innerText()).length,
        faces: await win.evaluate(() => Array.from(document.fonts).map((font) => ({ family: font.family, status: font.status }))) }));
      expect(ink, `page ${page} should contain printed marks`).toBeGreaterThan(500);
    }
    await win.getByRole('link', { name: 'Open in Evidence', exact: true }).first().click();
    await win.getByRole('textbox', { name: 'A name for a new project' }).fill('CFF Reader');
    await win.getByRole('button', { name: 'Start', exact: true }).click();
    await win.getByRole('button', { name: /Add piwowar-2007.pdf to This Project/ }).click();
    const evidence = win.getByRole('region', { name: 'Evidence reader' });
    await expect(evidence.locator('[data-evidence="examined"]')).toHaveText(/Text extraction could not read page 1 of 5/, { timeout: 45_000 });
    await expect(evidence).toContainText('The engine does not support text extraction for this page.');
    await expect(evidence.locator('.ev-sheet[data-page="1"][data-drawn="true"]')).toBeVisible();
    await evidence.getByRole('button', { name: 'Next Page', exact: true }).click();
    await expect(evidence.locator('[data-evidence="examined"]')).toHaveText(/Text extraction could not read page 2 of 5/, { timeout: 45_000 });
    await expect(evidence).not.toContainText('file is malformed');
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'pdf-cff-drawing-and-page-refusal.png') });
  } finally {
    await app.close(); removeStateDir(state); fs.rmSync(parent, { recursive: true, force: true });
  }
});
