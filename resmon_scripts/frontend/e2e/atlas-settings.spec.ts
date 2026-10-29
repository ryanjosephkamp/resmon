/**
 * Atlas: Settings' background service, email and notifications, and Search ›
 * Saved, in the real app.
 *
 * One paused watch is made over the API, set to email its report and to
 * notify, so each group has something real to name. Then what a person does:
 * read what is installed, running and attached; send a test email with nothing
 * configured and then at a port that refuses, with a password stored and never
 * shown; change the notification choices and read them back after a reload;
 * save a search from Ask the sources, export it, hand that file to Import,
 * and open it again.
 *
 * **Isolated where the fixture is not.** The unit directory is this spec's
 * own (`RESMON_SERVICE_UNIT_DIR`), so the panel reads nothing of this
 * machine's LaunchAgents, and the service switch is never pressed: installing
 * would register a real launch agent. The keyring is an in-memory one written
 * into the state directory, as composer-choices.spec.ts does, because the
 * fixture's null keyring accepts a password and stores nothing, which would
 * leave the stored password unreadable here.
 *
 * The journeys J04, J21 and J23 drive the same screens through
 * `journeys/drivers/atlas.ts`; this spec is the part that runs on every pull
 * request.
 */
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { FRONTEND_ROOT, SCREENSHOT_DIR, launchEnv, registerStateDir } from './fixtures/resmon-app';

const KEYRING = `import keyring.backend
_VALUES = {}
class Keyring(keyring.backend.KeyringBackend):
    priority = 1
    def get_password(self, service, username):
        return _VALUES.get((service, username))
    def set_password(self, service, username, password):
        _VALUES[(service, username)] = password
    def delete_password(self, service, username):
        _VALUES.pop((service, username))
`;

const PASSWORD = 'e2e-smtp-password-never-real';

async function api(win: Page, method: string, route: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  return win.evaluate(async ([m, r, b]) => {
    const port = (window as unknown as { resmonAPI: { getBackendPort(): string } }).resmonAPI.getBackendPort();
    const res = await e2eFetch(`http://127.0.0.1:${port}${r}`, {
      method: m, headers: { 'Content-Type': 'application/json' },
      body: b === undefined ? undefined : JSON.stringify(b),
    });
    return { status: res.status, body: await res.json() as unknown };
  }, [method, route, body] as const);
}

/** A loopback port the operating system just said was free, and that nothing now listens on. */
function aClosedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

test('Settings and Saved: what runs in the background, email and its password, notifications, and a saved search round trip', async () => {
  test.setTimeout(300_000);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-settings-'));
  const units = path.join(stateDir, 'units');
  fs.mkdirSync(units);
  fs.writeFileSync(path.join(stateDir, 'settings_keyring.py'), KEYRING);
  const env: Record<string, string> = {
    ...launchEnv(stateDir, true), RESMON_UI: 'atlas', RESMON_SERVICE_UNIT_DIR: units,
    PYTHON_KEYRING_BACKEND: 'settings_keyring.Keyring',
  };
  env.PYTHONPATH = stateDir + path.delimiter + (env.PYTHONPATH ?? '');

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

    // One paused watch that emails its report and is set to notify.
    const made = await api(win, 'POST', '/api/routines', {
      name: 'Perovskite films', schedule_cron: '0 9 * * *', is_active: false, email_enabled: true,
      notify_on_complete: true, parameters: { repositories: ['arxiv'], keywords: ['perovskite'], max_results: 50 },
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const watchId = Number((made.body as { id: number }).id);

    // — In the background: three facts, and the switch never pressed --------
    await win.evaluate(() => { window.location.hash = '#/settings/background'; });
    const service = win.locator('section.service');
    await expect(service).toHaveAttribute('aria-busy', 'false', { timeout: 60_000 });
    await expect(service.locator('[data-service="status"]')).toContainText('Not installed');
    await expect(service.locator('[data-service="unit-path"]')).toContainText(units);
    await expect(service.locator('[data-service="running"]')).toContainText('There is no daemon running');
    // This window's engine runs no scheduler, so the sentence must not promise
    // that watches run while it is open.
    await expect(service.locator('[data-service="running"]')).toContainText('nothing runs your watches on schedule');
    await expect(service).not.toContainText('only while a resmon window is open');
    const port = await win.evaluate(() => (window as unknown as { resmonAPI: { getBackendPort(): string } }).resmonAPI.getBackendPort());
    await expect(service.locator('[data-service="window"]')).toContainText(`127.0.0.1:${port}`);
    await expect(service.locator('[data-service="window"]')).toContainText('an engine it started itself');
    await expect(service.locator('[role="switch"][data-switch="service"]')).toHaveAttribute('aria-checked', 'false');
    expect(fs.readdirSync(units), 'the panel wrote a unit file it was never asked to').toEqual([]);
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-settings-background.png') });

    // — Email: what is missing, then a refusal, and the password never shown --
    await win.getByRole('navigation', { name: 'Settings groups' }).getByRole('link', { name: 'Email' }).click();
    const email = win.locator('section.email');
    await expect(email).toHaveAttribute('aria-busy', 'false', { timeout: 60_000 });
    await expect(email.locator('[data-email="mailing"]')).toContainText('One watch emails its report: Perovskite films');
    await expect(email.locator('[data-email="password"]')).toHaveAttribute('data-state', 'absent', { timeout: 30_000 });
    await email.locator('[data-email="test"]').click();
    await expect(email.locator('[data-email="test-result"]')).toHaveAttribute('data-state', 'refused', { timeout: 30_000 });
    await expect(email.locator('[data-email="test-result"]')).toContainText('SMTP not fully configured');

    const closed = await aClosedPort();
    await win.locator('#smtp-server').fill('127.0.0.1');
    await win.locator('#smtp-port').fill(String(closed));
    await win.locator('#smtp-username').fill('e2e@fixture.invalid');
    await win.locator('#smtp-from').fill('e2e@fixture.invalid');
    await win.locator('#smtp-to').fill('someone@fixture.invalid, another@fixture.invalid');
    await win.locator('#smtp-password').fill(PASSWORD);
    await email.locator('.password-row').getByRole('button', { name: 'Store' }).click();
    await expect(email.locator('[data-email="password"]')).toHaveAttribute('data-state', 'present', { timeout: 30_000 });
    await expect(win.locator('#smtp-password')).toHaveValue('');
    // Unsaved fields are saved before the test, which reads what is stored.
    await expect(email.locator('[data-email="test"]')).toHaveText('Save and send a test email');
    await email.locator('[data-email="test"]').click();
    // The engine words a refused connection one of two ways, depending on where
    // the failure surfaced; both say the send failed.
    await expect(email.locator('[data-email="test-result"]')).toHaveAttribute('data-state', 'refused', { timeout: 60_000 });
    await expect(email.locator('[data-email="test-result"]')).toContainText(/failed/);
    await expect(email.locator('[data-email="test"]')).toHaveText('Send a test email');

    await win.reload();
    await expect(win.locator('#smtp-port')).toHaveValue(String(closed), { timeout: 60_000 });
    await expect(win.locator('#smtp-to')).toHaveValue('someone@fixture.invalid, another@fixture.invalid');
    await expect(win.locator('#smtp-password')).toHaveValue('');
    await expect(email.locator('[data-email="password-status"]')).toContainText('A password is stored');
    expect(await win.locator('section.email').innerText(), 'the password came back onto the screen').not.toContain(PASSWORD);
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-settings-email.png') });

    // — Notifications: two choices, kept through a reload --------------------
    await win.getByRole('navigation', { name: 'Settings groups' }).getByRole('link', { name: 'Notifications' }).click();
    const notifications = win.locator('section.notifications');
    const manual = notifications.locator('[role="switch"][data-switch="notify_manual"]');
    await expect(manual).toHaveAttribute('aria-checked', 'true', { timeout: 60_000 });
    await expect(notifications.locator('[data-notify="set-to-notify"]')).toContainText('Perovskite films');
    const putNotifications = () => win.waitForResponse((r) => r.url().endsWith('/api/settings/notifications') && r.request().method() === 'PUT');
    let saved = putNotifications();
    await manual.click();
    expect((await saved).ok()).toBe(true);
    saved = putNotifications();
    await notifications.locator('input[value="all"]').check();
    expect((await saved).ok()).toBe(true);
    await win.reload();
    await expect(manual).toHaveAttribute('aria-checked', 'false', { timeout: 60_000 });
    await expect(notifications.locator('input[value="all"]')).toBeChecked();

    // — Saved: Save this search, export, that file imported, and Ask again ---
    await win.evaluate(() => { window.location.hash = '#/search/ask'; });
    await expect(win.getByRole('heading', { name: 'Ask the sources', level: 1 })).toBeVisible({ timeout: 60_000 });
    await win.getByRole('button', { name: 'Deep Sweep', exact: true }).click();
    await win.locator('.source[data-source="arxiv"] input').check();
    await win.locator('.source[data-source="biorxiv"] input').check();
    const terms = win.getByLabel('Search terms');
    await terms.fill('perovskite');
    await terms.press('Enter');
    await win.locator('[data-saved="keep"]').click();
    await win.locator('#keep-name').fill('Perovskites, two preprint servers');
    // Enter saves the name; it must not start a run.
    await win.locator('#keep-name').press('Enter');
    await expect(win.locator('[data-saved="kept"]')).toContainText('Perovskites, two preprint servers', { timeout: 30_000 });
    expect(await win.evaluate(() => window.location.hash)).toBe('#/search/ask');

    await win.locator('[data-saved="kept"] a').click();
    await expect(win.getByRole('heading', { name: 'Saved', level: 1 })).toBeVisible({ timeout: 60_000 });
    const search = win.locator('li.saved[data-kind="manual_sweep"]');
    await expect(search).toHaveCount(1, { timeout: 30_000 });
    await expect(search.locator('.meta')).toContainText('arXiv, bioRxiv');
    const copy = win.locator('li.saved[data-kind="routine"]');
    await expect(copy).toHaveCount(1);
    await expect(copy.getByRole('link', { name: 'Open the watch' })).toHaveAttribute('href', `#/watches/${watchId}`);

    // Export is a download, like every other export: the system is asked where
    // it goes, and only that destination is chosen here. The engine's own
    // export route, which writes wherever it likes, is never called.
    await search.locator('.saved-pick input').check();
    const archive = path.join(stateDir, 'saved-export.zip');
    let askedTheEngineToWrite = false;
    win.on('request', (r) => { if (r.url().endsWith('/api/configurations/export')) askedTheEngineToWrite = true; });
    await app.evaluate(({ BrowserWindow }, target) => {
      BrowserWindow.getAllWindows()[0].webContents.session.once('will-download', (_e, item) => {
        item.setSavePath(target as string);
      });
    }, archive);
    await win.locator('[data-saved="export"]').click();
    await expect(win.locator('[data-saved="exported"]')).toContainText('Put 1 saved search into', { timeout: 30_000 });
    await expect(win.locator('[data-saved="exported"] code')).toHaveText(/^resmon-saved-\d{8}T\d{6}\.zip$/);
    await expect.poll(() => (fs.existsSync(archive) ? fs.statSync(archive).size : 0), { timeout: 30_000 }).toBeGreaterThan(0);
    expect(fs.readFileSync(archive).subarray(0, 4).join(',')).toBe('80,75,3,4');
    expect(askedTheEngineToWrite).toBe(false);

    const chooser = win.waitForEvent('filechooser');
    await win.locator('[data-saved="import"]').click();
    const picker = await chooser;
    expect(await picker.element().getAttribute('accept')).toContain('.zip');
    await picker.setFiles(archive);
    await expect(win.locator('[data-saved="imported"]')).toHaveText('Imported 1 saved search.', { timeout: 30_000 });
    await expect(win.locator('li.saved[data-kind="manual_sweep"]')).toHaveCount(2);
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-saved.png') });

    await win.locator('li.saved[data-kind="manual_sweep"]').first().getByRole('button', { name: 'Ask again' }).click();
    await expect(win.locator('.keep-from')).toContainText('Perovskites, two preprint servers', { timeout: 30_000 });
    await expect(win.locator('.source[data-source="arxiv"] input')).toBeChecked();
    await expect(win.locator('.source[data-source="biorxiv"] input')).toBeChecked();
    await expect(win.locator('.term')).toHaveText(['perovskite']);
    await expect(win.getByRole('button', { name: 'Ask 2 sources' })).toBeEnabled();

    fs.rmSync(archive, { force: true });
    expect(problems).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
