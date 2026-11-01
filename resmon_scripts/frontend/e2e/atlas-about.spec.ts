/**
 * Atlas: Settings › About resmon, in the real app.
 *
 * Reached from the Settings rail. Who made it comes first: the credit row
 * his sites end with, its marks drawn in the page. The version and the build
 * are the engine's own (`/api/health`), the license is the repository's
 * `LICENSE` word for word, and the keychain is named for this platform. The
 * report link and one of the maker's links are clicked: each opens its page
 * in a link window of its own, and the request for that page is cancelled
 * before it leaves this machine, as `main-window.spec.ts` cancels its
 * attribution link. The page's Keyboard shortcuts button opens the sheet.
 *
 * Every request the window makes beyond the engine on loopback is recorded
 * and refused while this spec runs, so "drawing the page asks nothing of any
 * server" is measured: the outside requests are the clicks', and the engine
 * receives no write from the page at all.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { FRONTEND_ROOT, REPO_ROOT, SCREENSHOT_DIR, launchEnv, registerStateDir } from './fixtures/resmon-app';

const ISSUES = 'https://github.com/ryanjosephkamp/resmon/issues';
const GITHUB = 'https://github.com/ryanjosephkamp/';

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
  const env: Record<string, string> = { ...launchEnv(stateDir, true) };
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

      // — who made it: the maker's credit row, near the top, drawn in the page ----------------
      const credit = about.locator('[data-about="credit"]');
      await expect(credit.getByRole('heading', { name: 'Who made it', level: 3 })).toBeVisible();
      expect(await about.locator('.about-part').first().getAttribute('data-about')).toBe('credit');
      await expect(credit.locator('.credit-made')).toHaveText('Made by Ryan Kamp');
      await expect(credit.getByRole('link', { name: 'Ryan Kamp', exact: true })).toHaveAttribute('href', 'https://ryanjosephkamp.github.io/');
      const online = credit.getByRole('list', { name: 'Ryan Kamp online' }).getByRole('link');
      expect(await online.evaluateAll((links) => links.map((a) => [a.getAttribute('aria-label'), a.getAttribute('href'), a.getAttribute('target')])))
        .toEqual([
          ['Ryan Kamp’s website', 'https://ryanjosephkamp.github.io/', '_blank'],
          ['Ryan Kamp on GitHub', GITHUB, '_blank'],
          ['Ryan Kamp on LinkedIn', 'https://www.linkedin.com/in/rjk1999', '_blank'],
          ['Ryan Kamp on X', 'https://x.com/ryanjosephkamp', '_blank'],
          ['Ryan Kamp on YouTube', 'https://m.youtube.com/@RyanJosephKamp', '_blank'],
        ]);
      await expect(credit.getByRole('link', { name: 'Sponsor on GitHub' })).toHaveAttribute('href', 'https://github.com/sponsors/ryanjosephkamp');
      // Each mark is an inline drawing, not an image or a reference to one.
      expect(await credit.locator('svg').count()).toBe(6);
      expect(await credit.locator('img, use, image, link').count()).toBe(0);
      await credit.scrollIntoViewIfNeeded();
      for (const scheme of ['light', 'dark'] as const) {
        await win.emulateMedia({ colorScheme: scheme });
        await win.waitForTimeout(200);
        await credit.screenshot({ path: path.join(SCREENSHOT_DIR, `atlas-about-credit-${scheme}.png`) });
      }
      await win.emulateMedia({ colorScheme: null });

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

      // — a credit link opens its site the same way, and only on a click ------------------
      await credit.getByRole('link', { name: 'Ryan Kamp on GitHub' }).click();
      await expect.poll(() => outside.evaluate((facts) => facts.refused), { timeout: 20_000 }).toEqual([ISSUES, GITHUB]);
      await expect.poll(() => app.windows().length, { timeout: 20_000 }).toBe(before + 2);

      // — the keyboard's shortcuts, one button away -----------------------------------
      await win.bringToFront();
      await about.locator('[data-about="show-shortcuts"]').click();
      const sheet = win.getByRole('dialog', { name: 'Keyboard shortcuts' });
      await expect(sheet).toBeVisible();
      await win.keyboard.press('Escape');
      await expect(sheet).toBeHidden();
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
