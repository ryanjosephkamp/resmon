/** Synthetic real backend + renderer + Electron download; native dialog is manual evidence. */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { test, expect, _electron as electron } from '@playwright/test';
import { FRONTEND_ROOT, launchEnv, ensureScreenshotDir } from './fixtures/resmon-app';

test('selected runs save one entry per stored paper with globally unique keys', async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-reading-export-'));
  const env = launchEnv(state, true);
  env.RESMON_DISABLE_SCHEDULER = '1';
  env.PYTHON_KEYRING_BACKEND = 'keyring.backends.null.Keyring';
  const helper = path.resolve(FRONTEND_ROOT, '../verification_scripts/test_reading_export_continuity.py');
  const fixture = JSON.parse(execFileSync(env.RESMON_PYTHON, [helper, 'seed', env.RESMON_DB_PATH], { env, encoding: 'utf8' }));
  const snapshot = () => execFileSync(env.RESMON_PYTHON, [helper, 'snapshot', env.RESMON_DB_PATH], { env, encoding: 'utf8' });
  const before = snapshot();
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${path.join(state, 'electron-user-data')}`],
    cwd: FRONTEND_ROOT, env, timeout: 180_000,
  });
  try {
    const win = await app.firstWindow({ timeout: 180_000 });
    await win.locator('.app-main').waitFor({ state: 'visible', timeout: 60_000 });
    const port = await win.evaluate(() => (window as unknown as { resmonAPI: { getBackendPort(): string } }).resmonAPI.getBackendPort());
    expect(port).not.toBe('8742');
    const health = await (await win.request.get(`http://127.0.0.1:${port}/api/health`)).json();
    expect(Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(health.pid)], { encoding: 'utf8' }).trim())).toBe(app.process().pid);
    console.log('READING_INSTANCE', JSON.stringify({ state, port, health, parentPid: app.process().pid, fixture }));
    await win.evaluate(() => { window.location.hash = '#/results'; });
    for (const id of fixture.selected_execution_ids) {
      const row = win.getByText(`Execution #${id}`, { exact: true }).locator('xpath=ancestor::tr');
      await row.getByRole('checkbox').check();
    }
    await win.screenshot({ path: path.join(ensureScreenshotDir(), 'reading-export-selected.png') });
    for (const format of ['BibTeX', 'RIS', 'CSV']) {
      const destination = path.join(state, `combined.${format === 'BibTeX' ? 'bib' : format.toLowerCase()}`);
      // Exercise Electron's actual download and filesystem path; this replaces
      // the destination picker only, not bytes, renderer, request or serializer.
      await app.evaluate(({ BrowserWindow }, target) => {
        BrowserWindow.getAllWindows()[0].webContents.session.once('will-download', (_event, item) => {
          item.setSavePath(target);
        });
      }, destination);
      await win.getByRole('button', { name: format, exact: true }).click();
      await expect.poll(() => fs.existsSync(destination)).toBe(true);
      await expect.poll(() => fs.readFileSync(destination, 'utf8').length).toBeGreaterThan(0);
      const bytes = fs.readFileSync(destination);
      const text = bytes.toString('utf8');
      if (format === 'BibTeX') {
        const keys = [...text.matchAll(/^@\w+\{([^,]+),/gm)].map((match) => match[1]);
        expect(keys).toHaveLength(3);
        expect(new Set(keys).size).toBe(3);
        for (const title of ['Continuity Alpha', 'Continuity Beta', 'Continuity Gamma']) expect(text).toContain(title);
      } else if (format === 'RIS') {
        expect(text.match(/^TY  - /gm)).toHaveLength(3);
      } else {
        expect(text.trim().split('\n')).toHaveLength(4);
        expect(text.split('\n')[0]).toBe('title,authors,publication_date,doi,url,source_repository,external_id,categories,abstract\r');
      }
      console.log('READING_SAVED', JSON.stringify({ format, entries: 3, selectedLinks: 5,
        sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }));
    }
    expect(snapshot()).toBe(before);
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(state, { recursive: true, force: true });
  }
});
