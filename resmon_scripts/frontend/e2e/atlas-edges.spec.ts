/**
 * Atlas: Settings' last groups and Today's first-run card, in the real app.
 *
 * A fresh install shows the first-run card where the map will be, and Skip
 * keeps it gone across a relaunch. Sources stores a key as a fixed mask and
 * removes it again; a required credit is drawn without opening anything.
 * Backup writes a bundle to a chosen folder, checks it, stages a restore and
 * cancels it, and the staged restore never moves a byte; a second case stages
 * one, restarts resmon from the Backup screen, and reads what the next start
 * did; a third opens a resmon that had the upload to Google Drive after each
 * run switched on, which was removed, and Backup says so once. There is no
 * Cloud Storage group: resmon does not sign in to Google. The Danger zone
 * refuses the wrong word on screen and in the engine, and the right word
 * erases only what it names. Tutorials are recordings that ship with the app,
 * never frames or links out, and one plays only while it is on screen.
 *
 * **Scripted:** the folder chooser. Each state is held to the engine's record.
 * No network beyond loopback.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { execFileSync } from 'child_process';
import { FRONTEND_ROOT, REPO_ROOT, SCREENSHOT_DIR, launchEnv, registerStateDir } from './fixtures/resmon-app';

async function engine<T>(win: Page, route: string, method = 'GET', body?: unknown): Promise<{ status: number; body: T }> {
  return win.evaluate(async ([r, m, b]) => {
    const port = (window as unknown as { resmonAPI: { getBackendPort(): string } }).resmonAPI.getBackendPort();
    const response = await e2eFetch(`http://127.0.0.1:${port}${r}`, {
      method: m as string,
      headers: b === undefined ? {} : { 'Content-Type': 'application/json' },
      ...(b === undefined ? {} : { body: JSON.stringify(b) }),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  }, [route, method, body] as const) as Promise<{ status: number; body: T }>;
}

test('Settings and Today: first run, sources and keys, backup and restore, the danger zone, tutorials', async () => {
  test.setTimeout(300_000);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-edges-')));
  const stateDir = path.join(root, 'state');
  const backups = path.join(root, 'backups');
  for (const dir of [stateDir, backups]) fs.mkdirSync(dir);
  // An in-memory keyring, as the journeys use: never the person's keychain,
  // and unlike the null backend it keeps what is stored, so the mask a stored
  // key reads back as can be checked here. A dict in the backend process.
  const hooks = path.join(root, 'hooks');
  fs.mkdirSync(hooks);
  fs.writeFileSync(path.join(hooks, 'edges_keyring.py'), [
    'import keyring.backend', '', '_VALUES = {}', '', '',
    'class Keyring(keyring.backend.KeyringBackend):',
    '    priority = 1',
    '    def get_password(self, service, username):',
    '        return _VALUES.get((service, username))',
    '    def set_password(self, service, username, password):',
    '        _VALUES[(service, username)] = password',
    '    def delete_password(self, service, username):',
    '        try:',
    '            del _VALUES[(service, username)]',
    '        except KeyError:',
    '            from keyring.errors import PasswordDeleteError',
    '            raise PasswordDeleteError(username) from None', '',
  ].join('\n'));
  const base = launchEnv(stateDir, true);
  const env: Record<string, string> = {
    ...base, RESMON_UI: 'atlas', PYTHON_KEYRING_BACKEND: 'edges_keyring.Keyring',
    PYTHONPATH: [hooks, base.PYTHONPATH].filter(Boolean).join(path.delimiter),
  };
  const launch = () => electron.launch({
    args: ['.', `--user-data-dir=${path.join(stateDir, 'electron-user-data')}`],
    cwd: FRONTEND_ROOT, env, colorScheme: null, timeout: 180_000,
  });
  registerStateDir(stateDir);
  let app = await launch();
  try {
    let win = await app.firstWindow({ timeout: 180_000 });
    const problems: string[] = [];
    win.on('pageerror', (e) => problems.push(e.message));
    await expect(win.getByRole('navigation', { name: 'Sections' })).toBeVisible({ timeout: 120_000 });

    // — the first-run card, where the map will be, and Skip that holds ------------------
    const card = win.locator('[data-today="first-run"]');
    await expect(card).toBeVisible({ timeout: 60_000 });
    await expect(card.locator('li[data-step]')).toHaveCount(3);
    await expect(card).toContainText('not the same as working');
    await expect(card).not.toContainText(/\bready\b/i);
    for (const mark of await card.locator('.first-run-mark').all()) {
      expect(['done', 'found', 'not done', 'could not check']).toContain(await mark.getAttribute('aria-label'));
    }
    const dismissed = win.waitForResponse((r) => r.url().includes('/api/onboarding/dismiss'));
    await card.getByRole('button', { name: 'Skip', exact: true }).click();
    expect((await dismissed).ok()).toBe(true);
    await expect(card).toHaveCount(0);
    await app.close();
    app = await launch();
    win = await app.firstWindow({ timeout: 180_000 });
    win.on('pageerror', (e) => problems.push(e.message));
    await expect(win.getByRole('navigation', { name: 'Sections' })).toBeVisible({ timeout: 120_000 });
    await expect(win.locator('.plate-waiting, .plate').first()).toBeVisible({ timeout: 60_000 });
    await expect(win.locator('[data-today="first-run"]')).toHaveCount(0);
    expect((await engine<{ dismissed: boolean }>(win, '/api/onboarding')).body.dismissed).toBe(true);

    // — Sources: a key stored is a fixed mask, and Remove takes it back -----------------
    await win.evaluate(() => { window.location.hash = '#/settings/sources'; });
    await expect(win.locator('section.sources')).toHaveAttribute('aria-busy', 'false', { timeout: 30_000 });
    const key = win.getByLabel('API key for Springer Nature', { exact: true });
    await key.fill('atlas-edges-not-a-real-key');
    const stored = win.waitForResponse((r) => r.url().includes('/api/credentials/') && r.request().method() === 'PUT');
    await key.press('Enter');
    expect((await stored).ok()).toBe(true);
    await expect(key).toHaveValue('');
    const keyring = await engine<{ keyring_responsive?: boolean; credentials: Record<string, { present?: boolean }> }>(win, '/api/credentials');
    const springer = Object.entries(keyring.body.credentials).find(([name]) => /springer/i.test(name))!;
    expect(springer[1].present, 'the in-memory keyring did not keep the key').toBe(true);
    if (springer[1].present) {
      await expect(key).toHaveAttribute('placeholder', '*'.repeat(12));
      await win.getByRole('button', { name: 'Remove the key for Springer Nature' }).click();
      await expect(key).not.toHaveAttribute('placeholder', '*'.repeat(12), { timeout: 30_000 });
    } else {
      console.log('[atlas-edges] NOT VERIFIED: the mask. The null keyring stored nothing, so no key was there to mask.');
    }
    expect(await win.locator('main.stage').innerText()).not.toContain('atlas-edges-not-a-real-key');
    const catalog = (await engine<{ attribution_requirement: string; attribution: string | null }[]>(win, '/api/repositories/catalog')).body;
    const owed = catalog.filter((e) => e.attribution_requirement === 'required' && e.attribution);
    await expect(win.locator('[data-sources="credits"] li')).toHaveCount(owed.length);

    // — Backup: a chosen folder, a bundle, a check, a staged restore, cancelled ----------
    await app.evaluate(({ dialog }, chosen) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
    }, backups);
    await win.evaluate(() => { window.location.hash = '#/settings/storage'; });
    await expect(win.locator('section.storage')).toHaveAttribute('aria-busy', 'false', { timeout: 30_000 });
    await expect(win.locator('main.stage')).toContainText('Credentials are never written into a backup');
    await win.getByRole('button', { name: 'Choose a folder' }).click();
    await expect(win.locator('[data-backup="destination"]')).toContainText(backups, { timeout: 30_000 });
    const written = win.waitForResponse((r) => r.url().endsWith('/api/backup') && r.request().method() === 'POST');
    await win.getByRole('button', { name: 'Back up now', exact: true }).click();
    const bundle = String((await (await written).json()).path);
    expect(bundle.startsWith(backups), 'the backup was not written into the chosen folder').toBe(true);
    expect(fs.existsSync(path.join(bundle, 'manifest.json'))).toBe(true);
    await expect(win.locator('[data-backup="last"]')).toContainText(bundle, { timeout: 30_000 });
    await app.evaluate(({ dialog }, chosen) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
    }, bundle);
    await win.getByRole('button', { name: 'Restore from a backup…' }).click();
    const report = win.getByRole('group', { name: 'The backup, checked' });
    await expect(report).toContainText('It checks out', { timeout: 30_000 });
    await report.getByRole('button', { name: 'Stage this restore' }).click();
    await expect(win.locator('[data-backup="pending"]')).toBeVisible({ timeout: 30_000 });
    expect((await engine<{ pending_restore: unknown }>(win, '/api/backup/last')).body.pending_restore).toBeTruthy();
    await win.locator('[data-backup="pending"]').getByRole('button', { name: 'Cancel it' }).click();
    await expect(win.locator('[data-backup="pending"]')).toHaveCount(0, { timeout: 30_000 });
    expect((await engine<{ pending_restore: unknown }>(win, '/api/backup/last')).body.pending_restore).toBeFalsy();

    // — No Cloud Storage: resmon does not sign in to Google, on screen or in the engine ---
    const rail = win.getByRole('navigation', { name: 'Settings groups' });
    await expect(rail.getByRole('link', { name: 'Backup', exact: true })).toBeVisible();
    await expect(rail.getByRole('link', { name: 'Cloud Storage' })).toHaveCount(0);
    expect((await engine(win, '/api/cloud/status')).status).toBe(404);
    expect((await engine(win, '/api/settings/cloud')).status).toBe(404);
    // Fresh, nothing was switched on, so Backup has nothing to say about the upload.
    expect((await engine<{ drive_upload_retired: boolean }>(win, '/api/backup/last')).body.drive_upload_retired).toBe(false);
    await expect(win.locator('[data-backup="drive-upload-removed"]')).toHaveCount(0);

    // — the Danger zone: the wrong word refused twice, the right word exact -----------
    await engine(win, '/api/configurations', 'POST', { name: 'Kept through the erase', config_type: 'manual_dive',
      parameters: { repository: 'arxiv', keywords: ['kept'], max_results: 10, ai_enabled: false } });
    const configsBefore = (await engine<unknown[]>(win, '/api/configurations')).body.length;
    await win.evaluate(() => { window.location.hash = '#/settings/danger'; });
    const row = win.locator('.danger-row[data-danger="corpus"]');
    await row.getByRole('button', { name: 'Erase the paper corpus' }).click();
    const form = row.getByRole('group', { name: 'Confirm: Erase the paper corpus' });
    await form.getByPlaceholder('Type CONFIRM').fill('DELETE');
    await expect(form.getByRole('button', { name: 'Confirm' })).toBeDisabled();
    expect((await engine(win, '/api/admin/erase-corpus', 'POST', { confirm: 'DELETE' })).status).toBe(400);
    await form.getByPlaceholder('Type CONFIRM').fill('CONFIRM');
    const erased = win.waitForResponse((r) => r.url().includes('/api/admin/erase-corpus'));
    await form.getByRole('button', { name: 'Confirm' }).click();
    expect((await erased).status()).toBe(200);
    await expect(row.getByRole('status')).toContainText(/^There were no papers to remove\.$/, { timeout: 30_000 });
    expect((await engine<unknown[]>(win, '/api/configurations')).body.length, 'erasing papers took a saved search').toBe(configsBefore);

    // — Tutorials: the app's own recordings, never frames or links out ------------------
    const fromElsewhere: string[] = [];
    const notice = (request: { url(): string }) => {
      if (!request.url().startsWith('http://127.0.0.1:')) fromElsewhere.push(request.url());
    };
    win.on('request', notice);
    await win.evaluate(() => { window.location.hash = '#/settings/tutorials'; });
    await expect(win.getByRole('heading', { name: 'Tutorials', level: 2 })).toBeVisible();
    expect(await win.locator('main.stage').locator('iframe, webview, object, embed').count()).toBe(0);
    const tutorials = win.locator('section.tutorials');
    expect(await tutorials.locator('a[href^="http"]').count()).toBe(0);
    await expect(tutorials.locator('li[data-tutorial]')).toHaveCount(7);
    await expect(tutorials).toContainText('Ask has no recording yet');
    // Every picture is drawn, from the renderer's own origin: the GIF of the one on
    // screen, and the still of each further down.
    const origin = new URL(win.url()).origin;
    const pictures = await tutorials.locator('img').evaluateAll((imgs) => Promise.all(imgs.map(async (node) => {
      const img = node as HTMLImageElement;
      const drawn = await img.decode().then(() => img.naturalWidth, () => 0);
      return { src: img.currentSrc || img.src, drawn };
    })));
    expect(pictures).toHaveLength(7);
    for (const p of pictures) {
      expect(new URL(p.src).origin, `${p.src} is not the app's own file`).toBe(origin);
      expect(p.drawn, `${p.src} was not drawn`).toBe(960);
    }
    await expect(tutorials.locator('li[data-tutorial="today"] img')).toHaveAttribute('data-picture', 'gif');
    await expect(tutorials.locator('li[data-tutorial="getting-around"] img')).toHaveAttribute('data-picture', 'still');
    // Paused, it stays on its still; scrolled to, the next one plays.
    await tutorials.getByRole('button', { name: 'Pause Today' }).click();
    await expect(tutorials.locator('li[data-tutorial="today"] img')).toHaveAttribute('data-picture', 'still');
    await tutorials.locator('li[data-tutorial="getting-around"] .tutorial-frame').scrollIntoViewIfNeeded();
    await expect(tutorials.locator('li[data-tutorial="getting-around"] img')).toHaveAttribute('data-picture', 'gif');
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-tutorials.png') });
    win.off('request', notice);
    expect(fromElsewhere, 'the Tutorials page fetched from somewhere other than the app').toEqual([]);

    await win.evaluate(() => { window.location.hash = '#/settings/storage'; });
    await expect(win.locator('section.storage')).toHaveAttribute('aria-busy', 'false', { timeout: 30_000 });
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-edges.png') });
    expect(problems, 'the renderer threw').toEqual([]);
  } finally {
    await app.close().catch(() => {});
  }
});

test('a resmon that had the upload to Google Drive on is told once, on Backup, that it has gone', async () => {
  test.setTimeout(300_000);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-drive-')));
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(stateDir);
  const env: Record<string, string> = { ...launchEnv(stateDir, true), RESMON_UI: 'atlas' };
  // What a person who switched the upload on before it was removed has: the
  // switch, as the engine stored it, in a database this version has opened.
  execFileSync(env.RESMON_PYTHON, ['-c', [
    'import sys',
    'from implementation_scripts.database import get_connection, init_db, set_setting',
    'conn = get_connection(sys.argv[1])',
    'init_db(conn=conn)',
    "set_setting(conn, 'cloud_provider', 'google_drive')",
    "set_setting(conn, 'cloud_auto_backup', 'true')",
    'conn.commit()',
  ].join('\n'), env.RESMON_DB_PATH], { cwd: path.join(REPO_ROOT, 'resmon_scripts'), env });
  const launch = () => electron.launch({
    args: ['.', `--user-data-dir=${path.join(stateDir, 'electron-user-data')}`],
    cwd: FRONTEND_ROOT, env, colorScheme: null, timeout: 180_000,
  });
  registerStateDir(stateDir);
  let app = await launch();
  try {
    let win = await app.firstWindow({ timeout: 180_000 });
    const problems: string[] = [];
    win.on('pageerror', (e) => problems.push(e.message));
    await expect(win.getByRole('navigation', { name: 'Sections' })).toBeVisible({ timeout: 120_000 });
    expect((await engine<{ drive_upload_retired: boolean }>(win, '/api/backup/last')).body.drive_upload_retired).toBe(true);

    await win.evaluate(() => { window.location.hash = '#/settings/storage'; });
    await expect(win.locator('section.storage')).toHaveAttribute('aria-busy', 'false', { timeout: 30_000 });
    const notice = win.getByRole('group', { name: 'The upload to Google Drive was removed' });
    await expect(notice).toContainText('resmon no longer uploads to Google Drive.');
    await expect(notice).toContainText('which was switched on here, has been removed, and resmon does not sign in to Google');
    // What replaces it is on the same screen, where the notice says it is.
    await expect(notice).toContainText('under Where backups go');
    await expect(win.locator('[data-backup="destination"]')).toContainText('Google Drive for desktop');
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-backup-drive-upload-removed.png') });

    const dismissed = win.waitForResponse((r) => r.url().endsWith('/api/backup/drive-upload-notice/acknowledge'));
    await notice.getByRole('button', { name: 'Got it' }).click();
    expect((await dismissed).ok()).toBe(true);
    await expect(notice).toHaveCount(0, { timeout: 30_000 });
    expect((await engine<{ drive_upload_retired: boolean }>(win, '/api/backup/last')).body.drive_upload_retired).toBe(false);

    // Once: not on the next start either.
    await app.close();
    app = await launch();
    win = await app.firstWindow({ timeout: 180_000 });
    win.on('pageerror', (e) => problems.push(e.message));
    await expect(win.getByRole('navigation', { name: 'Sections' })).toBeVisible({ timeout: 120_000 });
    await win.evaluate(() => { window.location.hash = '#/settings/storage'; });
    await expect(win.locator('section.storage')).toHaveAttribute('aria-busy', 'false', { timeout: 30_000 });
    await expect(win.locator('[data-backup="destination"]')).toBeVisible();
    await expect(win.locator('[data-backup="drive-upload-removed"]')).toHaveCount(0);
    expect(problems, 'the renderer threw').toEqual([]);
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a staged restore restarts resmon from Backup, the next start shows what it did, and its undo copy goes only when asked', async () => {
  test.setTimeout(300_000);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-restart-')));
  const stateDir = path.join(root, 'state');
  const backups = path.join(root, 'backups');
  for (const dir of [stateDir, backups]) fs.mkdirSync(dir);
  const env: Record<string, string> = { ...launchEnv(stateDir, true), RESMON_UI: 'atlas' };
  const launch = () => electron.launch({
    args: ['.', `--user-data-dir=${path.join(stateDir, 'electron-user-data')}`],
    cwd: FRONTEND_ROOT, env, colorScheme: null, timeout: 180_000,
  });
  registerStateDir(stateDir);
  let app = await launch();
  try {
    let win = await app.firstWindow({ timeout: 180_000 });
    await expect(win.getByRole('navigation', { name: 'Sections' })).toBeVisible({ timeout: 120_000 });

    // A bundle to restore, written by the engine into a folder of this run's.
    expect((await engine(win, '/api/settings/storage', 'PUT', { settings: { export_directory: backups } })).status).toBe(200);
    const written = await engine<{ path: string }>(win, '/api/backup', 'POST', { confirm: 'CONFIRM', include_reports: false });
    expect(written.status, JSON.stringify(written.body)).toBe(200);
    const bundle = written.body.path;

    // Staged from Backup, through the folder chooser.
    await app.evaluate(({ dialog }, chosen) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
    }, bundle);
    await win.evaluate(() => { window.location.hash = '#/settings/storage'; });
    await expect(win.locator('section.storage')).toHaveAttribute('aria-busy', 'false', { timeout: 30_000 });
    await win.getByRole('button', { name: 'Restore from a backup…' }).click();
    const report = win.getByRole('group', { name: 'The backup, checked' });
    await expect(report).toContainText('It checks out', { timeout: 30_000 });
    await report.getByRole('button', { name: 'Stage this restore' }).click();

    // This window started its own engine, so restarting the app is the start
    // that restores, and the control is offered; the engine's sentence is said
    // once, not again beside it.
    const pending = win.locator('[data-backup="pending"]');
    await expect(pending).toHaveAttribute('data-runs-on', 'app_restart', { timeout: 30_000 });
    await expect(win.locator('section.storage').getByText(/Quit resmon and open it again to restore/)).toHaveCount(1);
    const restart = pending.getByRole('button', { name: 'Restart resmon now' });
    await expect(restart).toBeVisible();

    // The real handler runs: it stops this window's engine and waits for it to
    // exit, then relaunches and quits. Those two are counted here rather than
    // done, because the relaunched app is a new process this harness does not
    // hold; the start it would make is made below by launching again.
    await app.evaluate(({ app: electronApp }) => {
      const calls = { relaunch: 0, quit: 0 };
      const held = { relaunch: electronApp.relaunch, quit: electronApp.quit };
      (globalThis as unknown as { __restart: unknown }).__restart = { calls, held };
      electronApp.relaunch = (() => { calls.relaunch += 1; }) as typeof electronApp.relaunch;
      electronApp.quit = (() => { calls.quit += 1; }) as typeof electronApp.quit;
    });
    const port = await win.evaluate(() => (window as unknown as { resmonAPI: { getBackendPort(): string } }).resmonAPI.getBackendPort());
    win.once('dialog', (dialog) => { void dialog.accept(); });
    await restart.click();
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __restart: { calls: unknown } }).__restart.calls),
      { timeout: 60_000 }).toEqual({ relaunch: 1, quit: 1 });
    const answered = await e2eFetch(`http://127.0.0.1:${port}/api/health`).then(() => true, () => false);
    expect(answered, 'the engine was still answering when the app relaunched').toBe(false);
    await app.evaluate(({ app: electronApp }) => {
      const { held } = (globalThis as unknown as { __restart: { held: { relaunch: typeof electronApp.relaunch; quit: typeof electronApp.quit } } }).__restart;
      electronApp.relaunch = held.relaunch;
      electronApp.quit = held.quit;
    });
    await app.close();

    // The start the relaunch makes: the restore runs, and Backup says what it did.
    app = await launch();
    win = await app.firstWindow({ timeout: 180_000 });
    await expect(win.getByRole('navigation', { name: 'Sections' })).toBeVisible({ timeout: 120_000 });
    await win.evaluate(() => { window.location.hash = '#/settings/storage'; });
    await expect(win.locator('section.storage')).toHaveAttribute('aria-busy', 'false', { timeout: 30_000 });
    await expect(win.locator('[data-backup="reentry"]')).toContainText('A backup was restored on this start.');
    await expect(win.locator('[data-backup="pending"]')).toHaveCount(0);
    const last = (await engine<{ pending_restore: unknown; last_restore: { ok: boolean; undo_copy: string | null }; undo_copies: string[] }>(
      win, '/api/backup/last')).body;
    expect(last.pending_restore).toBeNull();
    expect(last.last_restore.ok).toBe(true);
    expect(last.last_restore.undo_copy, 'the restore kept no copy of what it replaced').toBeTruthy();
    expect(last.undo_copies).toContain(last.last_restore.undo_copy);
    const restored = win.locator('[data-backup="restored"]');
    await expect(restored).toContainText(bundle);
    await expect(restored).toContainText(`What it replaced is kept in ${last.last_restore.undo_copy}`);
    // The restored database is the snapshot the backup took before it recorded itself, so it records no backup,
    // and Backup says why rather than that none was ever written.
    await expect(win.locator('[data-backup="last"]')).toHaveText(/^No backup is recorded in this database\. It is the one the last restore put back/);
    const deleteUndo = win.getByRole('button', { name: 'Delete what the last restore replaced' });
    await expect(deleteUndo).toBeVisible();
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-restore-restarted.png') });

    // The undo copy is the last way back, so deleting it is asked first: declined, it stays.
    const asked: string[] = [];
    win.once('dialog', (dialog) => { asked.push(dialog.message()); void dialog.dismiss(); });
    await deleteUndo.click();
    await expect.poll(() => asked.length).toBe(1);
    expect(asked[0]).toMatch(/^Delete what the last restore replaced\? It is the only copy of what was there before the restore/);
    expect(fs.existsSync(last.last_restore.undo_copy!), 'declining the question deleted the undo copy').toBe(true);
    await expect(deleteUndo).toBeVisible();
    // Accepted, it goes.
    win.once('dialog', (dialog) => { void dialog.accept(); });
    await deleteUndo.click();
    await expect(win.getByText('Deleted 1 saved copy of what a restore replaced.')).toBeVisible({ timeout: 30_000 });
    expect(fs.existsSync(last.last_restore.undo_copy!)).toBe(false);
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});
