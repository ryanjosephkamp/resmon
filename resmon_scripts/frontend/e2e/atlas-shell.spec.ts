/**
 * The Atlas renderer, served instead of the classic one when RESMON_UI=atlas.
 *
 * The rebuild builds the new interface beside the old (dist/atlas next to
 * dist/renderer) and the main process picks one at launch. This proves the
 * switch in the real app: the Atlas shell loads, reaches its own backend with
 * the window's token, and the classic renderer is not what was served. The
 * screens themselves arrive in later steps and get their own specs.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test, expect, _electron as electron } from '@playwright/test';
import { launchEnv, FRONTEND_ROOT } from './fixtures/resmon-app';

test('RESMON_UI=atlas serves the Atlas shell, connected to its own backend', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-'));
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${path.join(stateDir, 'electron-user-data')}`],
    cwd: FRONTEND_ROOT,
    env: { ...launchEnv(stateDir, true), RESMON_UI: 'atlas' },
    timeout: 180_000,
  });
  try {
    const win = await app.firstWindow({ timeout: 180_000 });
    await expect(win.getByLabel('resmon')).toBeVisible({ timeout: 60_000 });
    await expect(win.getByRole('navigation', { name: 'Sections' })).toBeVisible();
    // An empty collection: Today says so, which it can only do once the engine has answered.
    await expect(win.locator('.plate-waiting[role="status"]')).toHaveText(/Your collection is empty/, { timeout: 120_000 });
    const port = await win.evaluate(() => (window as unknown as { resmonAPI: { getBackendPort: () => string } }).resmonAPI.getBackendPort());
    expect(port, 'the installed service port is never used').not.toBe('8742');
    // The classic renderer's sidebar is not on the page.
    await expect(win.locator('.sidebar')).toHaveCount(0);
  } finally {
    await app.close().catch(() => { /* already gone */ });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
