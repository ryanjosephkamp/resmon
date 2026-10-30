/**
 * Atlas: Settings › About resmon, in the real app.
 *
 * Reached from the Settings rail. The version and the build are the engine's
 * own (`/api/health`), the license is the repository's `LICENSE` word for
 * word, and the keychain is named for this platform. The report link is
 * clicked: it opens GitHub's issues page in a link window of its own, and
 * the request for that page is cancelled before it leaves this machine, as
 * `main-window.spec.ts` cancels its attribution link.
 *
 * Every request the window makes beyond the engine on loopback is recorded
 * and refused while this spec runs, so "drawing the page asks nothing of any
 * server" is measured: the one outside request is the click's, and the
 * engine receives no write from the page at all.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { FRONTEND_ROOT, REPO_ROOT, SCREENSHOT_DIR, launchEnv, registerStateDir } from './fixtures/resmon-app';

const ISSUES = 'https://github.com/ryanjosephkamp/resmon/issues';

async function health(win: Page): Promise<{ version: string; identity: { build_id: string | null; schema_version: number | null } }> {
  return win.evaluate(async () => {
    const port = (window as unknown as { resmonAPI: { getBackendPort(): string } }).resmonAPI.getBackendPort();
    return (await e2eFetch(`http://127.0.0.1:${port}/api/health`)).json();
  });
}

const KEYCHAIN: Record<string, string> = {
  darwin: 'the macOS Keychain', win32: 'Windows Credential Manager', linux: 'the desktop’s keyring',
};

test('About resmon: the engine\'s version, the license as written, the keychain by name, and a report link that sends nothing', async () => {
  test.setTimeout(240_000);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-about-'));
  const env: Record<string, string> = { ...launchEnv(stateDir, true), RESMON_UI: 'atlas' };
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${path.join(stateDir, 'electron-user-data')}`],
    cwd: FRONTEND_ROOT, env, colorScheme: null, timeout: 180_000,
  });
  registerStateDir(stateDir);
  try {
    const win = await app.firstWindow({ timeout: 180_000 });
    const problems: string[] = [];
    win.on('pageerror', (e) => problems.push(e.message));
    await win.getByRole('navigation', { name: 'Sections' }).waitFor({ timeout: 120_000 });
    const mainId = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].id);

    // Everything beyond loopback is recorded and refused from here on.
    const port = await win.evaluate(() => (window as unknown as { resmonAPI: { getBackendPort(): string } }).resmonAPI.getBackendPort());
    const outside = await app.evaluateHandle(({ session }) => {
      const facts = { refused: [] as string[] };
      session.defaultSession.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
        const local = /^https?:\/\/127\.0\.0\.1(:\d+)?\//.test(details.url);
        if (!local) facts.refused.push(details.url);
        callback({ cancel: !local });
      });
      return facts;
    });
    const writes: string[] = [];
    win.on('request', (r) => {
      if (r.url().startsWith(`http://127.0.0.1:${port}/`) && r.method() !== 'GET') writes.push(`${r.method()} ${r.url()}`);
    });

    try {
      await win.evaluate(() => { window.location.hash = '#/settings'; });
      await win.getByRole('navigation', { name: 'Settings groups' }).getByRole('link', { name: 'About resmon' }).click();
      const about = win.locator('section.about');
      await expect(about.getByRole('heading', { name: 'About resmon', level: 2 })).toBeVisible({ timeout: 30_000 });
      await expect(about).toHaveAttribute('aria-busy', 'false', { timeout: 30_000 });
      expect(await win.evaluate(() => window.location.hash)).toBe('#/settings/about');

      // — the version and the build, as the engine reports them -------------------------
      const said = await health(win);
      await expect(about.locator('[data-about="version-words"]')).toHaveText(`resmon ${said.version}`);
      await expect(about.locator('[data-about="build"]')).toHaveText(said.identity.build_id
        ?? 'Not identified. The engine reports no build id, so none is named here.');

      // — the license, word for word ------------------------------------------------------
      await about.getByText('The license in full').click();
      const shown = await about.locator('.about-license pre').innerText();
      expect(shown.trim()).toBe(fs.readFileSync(path.join(REPO_ROOT, 'LICENSE'), 'utf8').trim());
      await expect(about.locator('[data-about="license"]')).toContainText('Copyright (c) 2026 Ryan Kamp.');

      // — what it keeps names this platform's keychain -------------------------------------
      const platform = await app.evaluate(() => process.platform);
      await expect(about.locator('[data-about="privacy"]')).toContainText(`are kept in ${KEYCHAIN[platform] ?? 'this computer’s credential store'}`);
      await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-about.png') });
      await about.locator('[data-about="report"]').scrollIntoViewIfNeeded();
      await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-about-privacy.png') });

      // Drawing the page asked nothing of any server but the engine.
      expect(await outside.evaluate((facts) => facts.refused)).toEqual([]);

      // — the report link opens GitHub's issues page, and only on a click ----------------
      const link = about.locator('[data-about="issues"]');
      await expect(link).toHaveAttribute('href', ISSUES);
      await expect(link).toHaveAttribute('target', '_blank');
      const before = app.windows().length;
      await link.click();
      await expect.poll(() => outside.evaluate((facts) => facts.refused), { timeout: 20_000 }).toEqual([ISSUES]);
      await expect.poll(() => app.windows().length, { timeout: 20_000 }).toBe(before + 1);
      const opened = await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()
        .filter((w) => w.id !== id).map((w) => w.getTitle()), mainId);
      expect(opened).toEqual([ISSUES]);
      expect(writes, 'About resmon wrote to the engine').toEqual([]);
    } finally {
      await app.evaluate(({ session, BrowserWindow }, id) => {
        session.defaultSession.webRequest.onBeforeRequest(null);
        for (const w of BrowserWindow.getAllWindows()) if (w.id !== id) w.destroy();
      }, mainId);
      await outside.dispose();
    }
    expect(problems).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
