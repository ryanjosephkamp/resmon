/**
 * The saved-configuration export/import round trip, in the real app.
 *
 * A walk of the shipped 2.3.0 saved a manual Deep Dive preset, exported it,
 * and could not hand the resulting file back to Import: the page refused any
 * name not ending `.json`, and the export writes a `.zip`. The renderer unit
 * tests mock the backend and the backend tests do not run the renderer, so
 * this spec is the only place the two halves meet with nothing in between:
 * the file the app wrote on disk is the file the app is given back.
 *
 * Nothing here unpacks, renames or rewrites the archive. The path comes from
 * the banner the user reads, and that exact path is what the file picker is
 * handed.
 */
import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FRONTEND_ROOT, launchEnv, ensureScreenshotDir, e2eAuth } from './fixtures/resmon-app';

test('the archive Export Selected writes is the file Import takes back', async () => {
  test.setTimeout(240_000);
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-configs-'));
  const env = launchEnv(state, true);
  env.RESMON_DISABLE_SCHEDULER = '1';
  env.PYTHON_KEYRING_BACKEND = 'keyring.backends.null.Keyring';

  const app = await electron.launch({
    args: ['.', `--user-data-dir=${path.join(state, 'electron-user-data')}`],
    cwd: FRONTEND_ROOT,
    env,
    timeout: 180_000,
  });

  try {
    const win = await app.firstWindow();
    await win.waitForSelector('.app-main');
    const port = await win.evaluate(
      () => (window as unknown as { resmonAPI: { getBackendPort(): string } }).resmonAPI.getBackendPort());
    // The live daemon's port is never this app's port.
    expect(port).not.toBe('8742');
    const base = `http://127.0.0.1:${port}`;

    // Seed the preset the walk saved by hand. The journey under test starts
    // at Export Selected, not at Save Configuration.
    const created = await win.request.post(`${base}/api/configurations`, {
      headers: e2eAuth(`${base}/api/configurations`),
      data: {
        name: 'codex-walk',
        config_type: 'manual_dive',
        parameters: { keywords: ['codex walk'], repository: 'arxiv' },
      },
    });
    expect(created.ok()).toBe(true);

    await win.getByRole('link', { name: 'Configurations' }).click();
    await win.getByRole('button', { name: 'Manual Configs' }).click();
    const row = win.locator('.simple-table tbody tr', { hasText: 'codex-walk' });
    await expect(row).toHaveCount(1);

    // ---- export, as a user does ----
    await row.locator('input[type="checkbox"]').check();
    await win.getByRole('button', { name: /^Export Selected \(1\)$/ }).click();
    const banner = win.locator('.form-success');
    await expect(banner).toContainText('Export saved to:');
    // The banner's own span, not the whole banner: the Reveal in Finder
    // button sits beside it and would be read as part of the path.
    const archive = (await banner.locator('span').first().innerText())
      .replace(/^[\s\S]*Export saved to:\s*/, '').trim();
    expect(fs.existsSync(archive)).toBe(true);
    // The container is what the defect was about; assert the bytes, not the
    // name, so a future change of suffix does not quietly pass this spec.
    expect(fs.readFileSync(archive).subarray(0, 2).toString('latin1')).toBe('PK');

    // ---- hand that exact file to Import ----
    await win.locator('input[type="file"]').setInputFiles(archive);
    await expect(win.locator('.form-success')).toContainText('Imported 1 configuration(s).');
    await expect(win.locator('.form-error')).toHaveCount(0);

    await expect(win.locator('.simple-table tbody tr', { hasText: 'codex-walk' })).toHaveCount(2);

    const after = await win.request.get(`${base}/api/configurations`, {
      headers: e2eAuth(`${base}/api/configurations`),
    });
    const rows = await after.json();
    expect(rows.filter((c: { name: string }) => c.name === 'codex-walk')).toHaveLength(2);

    // ---- a file it genuinely cannot take says what it wanted ----
    const stranger = path.join(state, 'notes.txt');
    fs.writeFileSync(stranger, 'not a configuration');
    await win.locator('input[type="file"]').setInputFiles(stranger);
    const refusal = win.locator('.form-error');
    await expect(refusal).toContainText('notes.txt');
    await expect(refusal).toContainText('.zip');

    const shots = ensureScreenshotDir();
    await win.screenshot({ path: path.join(shots, 'configurations-roundtrip.png') });
  } finally {
    await app.close();
  }
});
