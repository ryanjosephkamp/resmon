/**
 * Atlas: a watch made, changed and deleted in the editor, and where its
 * reports go, in the real app.
 *
 * Each step is checked against the engine's own record rather than against
 * the screen alone: the cron expression a schedule choice stores, the
 * parameters a save sends back (a field the editor does not show survives),
 * that a change never resumes or pauses, that a watch on a person stores the
 * person and no terms, and what a destination's switches write.
 *
 * **Nothing here fires.** Every watch the editor saves is saved paused, and
 * the one resumed over the API to prove a change leaves it watching is paused
 * again at once: an active watch would ask real sources at its next fire. The
 * keyring is an in-memory one written into the state directory, as
 * atlas-settings.spec.ts does, so a webhook's secret can be stored and its
 * presence read back without touching this machine's keychain.
 */
import * as fs from 'fs';
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

const SECRET = 'e2e-webhook-secret-never-real';

type Json = Record<string, unknown>;

async function api<T = Json>(win: Page, method: string, route: string, body?: unknown): Promise<T> {
  return win.evaluate(async ([m, r, b]) => {
    const port = (window as unknown as { resmonAPI: { getBackendPort(): string } }).resmonAPI.getBackendPort();
    const res = await e2eFetch(`http://127.0.0.1:${port}${r}`, {
      method: m, headers: { 'Content-Type': 'application/json' },
      body: b === undefined ? undefined : JSON.stringify(b),
    });
    return await res.json() as unknown;
  }, [method, route, body] as const) as Promise<T>;
}

async function stored(win: Page, id: number): Promise<Json & { parameters: Json }> {
  const row = await api<Json>(win, 'GET', `/api/routines/${id}`);
  return { ...row, parameters: JSON.parse(String(row.parameters)) as Json };
}

function idFrom(url: string): number {
  const match = /#\/watches\/(\d+)$/.exec(url);
  expect(match, `not on a watch's page: ${url}`).toBeTruthy();
  return Number(match?.[1]);
}

test('the watch editor: made, changed, a person, destinations, from a search, and deleted', async () => {
  test.setTimeout(420_000);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-editor-'));
  const units = path.join(stateDir, 'units');
  fs.mkdirSync(units);
  fs.writeFileSync(path.join(stateDir, 'editor_keyring.py'), KEYRING);
  const env: Record<string, string> = {
    ...launchEnv(stateDir, true), RESMON_SERVICE_UNIT_DIR: units,
    PYTHON_KEYRING_BACKEND: 'editor_keyring.Keyring',
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
    win.on('dialog', (dialog) => { void dialog.accept(); });
    await win.getByRole('navigation', { name: 'Sections' }).waitFor({ timeout: 120_000 });

    // Seeded over the API: a person, a watch on a schedule the choices cannot
    // state carrying a field the editor does not show, and a saved search.
    const person = await api<{ id: number }>(win, 'POST', '/api/profiles', {
      kind: 'person', display_name: 'Ada Fixture', names: [{ value: 'Ada Fixture' }], identifiers: {},
      affiliations: ['Example University'], field_hints: [], notes: null,
    });
    const firehose = await api<{ id: number }>(win, 'POST', '/api/routines', {
      name: 'Preprint firehose', schedule_cron: '*/15 * * * *', is_active: false, ai_enabled: false,
      parameters: { repositories: ['arxiv'], keywords: ['perovskite'], query: 'perovskite', max_results: 20, some_future_field: 'kept' },
    });
    // A watch on bioRxiv saved with no dates, as one made before a start was required.
    const undated = await api<{ id: number }>(win, 'POST', '/api/routines', {
      name: 'Preprints with no dates', schedule_cron: '0 8 * * *', is_active: false, ai_enabled: false,
      parameters: { repositories: ['arxiv', 'biorxiv'], keywords: ['perovskite'], query: 'perovskite', max_results: 20 },
    });
    await api(win, 'POST', '/api/configurations', {
      name: 'Tandem cells, two servers', config_type: 'manual_sweep',
      parameters: { repositories: ['arxiv', 'biorxiv'], date_from: '2026-09-01', date_to: '2026-10-01', keywords: ['tandem'], max_results: 40, ai_enabled: false },
    });

    // — made ----------------------------------------------------------------
    await win.evaluate(() => { window.location.hash = '#/watches'; });
    await win.locator('[data-editor="new"]').click();
    await win.locator('.source[data-source="arxiv"]').waitFor({ timeout: 60_000 });
    const save = win.getByRole('button', { name: 'Save watch' });
    await expect(save).toBeDisabled();
    await expect(win.locator('.ask-go .ask-facts p')).toHaveText(['Give it a name.', 'Add at least one term.', 'Choose at least one source.']);
    await expect(win.locator('[data-switch="is_active"]')).toHaveAttribute('aria-checked', 'true');
    await expect(win.locator('[data-will="schedule"] p').first()).toHaveText('Daily at 8:00 AM, in this computer’s time.');

    await win.locator('#watch-name').fill('Perovskite stability');
    await win.locator('#watch-terms').fill('perovskite');
    await win.keyboard.press('Enter');
    await win.locator('#watch-terms').fill('tandem');
    await win.keyboard.press('Enter');
    await win.locator('.source[data-source="arxiv"] input').check();
    await win.locator('.source[data-source="biorxiv"] input').check();
    // bioRxiv needs a start date: with no date limit the watch is not saved,
    // and the days its runs would otherwise be given are offered.
    await win.getByRole('radio', { name: 'No date limit' }).check();
    const needed = win.locator('[data-editor="start-needed"]');
    await expect(needed).toContainText('bioRxiv needs a start date, and this window gives none: resmon reads every preprint');
    await expect(win.locator('.ask-go .ask-facts p')).toHaveText([/^bioRxiv needs a start date, and this window gives none/]);
    await expect(save).toBeDisabled();
    // What it will do does not say what a run would ask bioRxiv in place of a start: it would not save.
    await expect(win.locator('[data-will="notice"]')).toHaveCount(0);
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-watch-editor-start-needed.png') });
    await needed.getByRole('button', { name: 'Ask for the last 3 days' }).click();
    await expect(win.getByRole('radio', { name: 'In the last 3 days' })).toBeChecked();
    await expect(needed).toHaveCount(0);
    await expect(save).toBeEnabled();
    // The default's own 3 days say nothing more; a longer window says it is read
    // from its newest end back and may not reach its start.
    await expect(win.locator('[data-will="notice"]')).toHaveCount(0);
    await win.getByRole('radio', { name: 'Papers published since the previous run' }).check();
    await expect(win.locator('[data-will="notice"]')).toHaveText([/^resmon reads bioRxiv from the newest preprints in your window back/]);
    await win.getByRole('button', { name: 'Weekdays', exact: true }).click();
    await win.getByLabel('Time of day').fill('07:30');
    await win.getByLabel('Most papers per source').fill('25');
    await win.locator('#watch-intent').fill('Tandem cells that stay stable outdoors');
    for (const name of ['notify_on_complete', 'email_enabled', 'email_ai_summary_enabled', 'is_active']) {
      await win.locator(`[data-switch="${name}"]`).click();
    }
    await expect(win.locator('[data-switch="is_active"]')).toHaveAttribute('aria-checked', 'false');
    await expect(win.locator('[data-will="schedule"] p').first()).toHaveText('Weekdays at 7:30 AM, in this computer’s time.');
    await expect(win.locator('[data-will="asks"] p').first())
      .toHaveText('Asks arXiv and bioRxiv for papers matching “perovskite” and “tandem”, published since its previous run, up to 25 from each.');
    // No email account is set up in this state directory, and it says so.
    await expect(win.locator('[data-will="no-email-account"]')).toBeVisible();
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-watch-editor-new.png') });
    // ⌘Enter (Ctrl+Enter) in any field of the editor saves the watch, as Save watch does.
    await expect(win.locator('.ask-go .enter-hint')).toBeVisible();
    await win.locator('#watch-intent').press('ControlOrMeta+Enter');

    await expect(win.locator('.watch-page [data-editor="said"]')).toHaveText('Saved, paused.', { timeout: 30_000 });
    const made = idFrom(win.url());
    let row = await stored(win, made);
    expect(row).toMatchObject({
      name: 'Perovskite stability', schedule_cron: '30 7 * * 1-5', is_active: false, notify_on_complete: true,
      email_enabled: true, email_ai_summary_enabled: true, ai_enabled: false, intent: 'Tandem cells that stay stable outdoors',
    });
    expect(row.parameters).toMatchObject({
      repositories: ['arxiv', 'biorxiv'], keywords: ['perovskite', 'tandem'], query: 'perovskite tandem',
      max_results: 25, date_from: '', date_to: '', date_window: { since: 'previous_run' },
    });
    expect(row.parameters).not.toHaveProperty('entity');

    // — changed -------------------------------------------------------------
    await win.locator('[data-editor="change"]').click();
    await expect(win.locator('#watch-name')).toHaveValue('Perovskite stability', { timeout: 30_000 });
    await expect(win.locator('.term')).toHaveText(['perovskite', 'tandem']);
    await expect(win.locator('.source[data-source="biorxiv"] input')).toBeChecked();
    await expect(win.getByRole('button', { name: 'Weekdays', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(win.getByLabel('Time of day')).toHaveValue('07:30');
    await win.getByRole('button', { name: 'Remove tandem' }).click();
    await win.locator('.source[data-source="biorxiv"] input').uncheck();
    await win.getByRole('button', { name: 'Once a week', exact: true }).click();
    await win.getByLabel('Day of the week').selectOption({ label: 'Monday' });
    await win.getByLabel('Time of day').fill('09:00');
    await expect(win.locator('[data-will="schedule"] p').first()).toHaveText('Mondays at 9:00 AM, in this computer’s time.');
    await expect(win.locator('[data-will="schedule"] p').nth(1)).toContainText('It is paused. Saving does not resume it');
    await win.getByRole('button', { name: 'Save changes' }).click();
    await expect(win.locator('.watch-page [data-editor="said"]')).toHaveText('Saved.', { timeout: 30_000 });
    row = await stored(win, made);
    expect(row).toMatchObject({ schedule_cron: '0 9 * * 1', is_active: false });
    expect(row.parameters).toMatchObject({ repositories: ['arxiv'], keywords: ['perovskite'], query: 'perovskite' });

    // A change leaves a watching watch watching: the editor sends no is_active.
    await api(win, 'POST', `/api/routines/${made}/activate`);
    await win.evaluate((id) => { window.location.hash = `#/watches/${id}/edit`; }, made);
    await expect(win.locator('[data-will="schedule"] p').nth(1)).toContainText('It is watching. Saving does not change that.', { timeout: 30_000 });
    await win.locator('#watch-name').fill('Perovskite stability, arXiv');
    await win.getByRole('button', { name: 'Save changes' }).click();
    await expect(win.locator('.watch-page [data-editor="said"]')).toHaveText('Saved.', { timeout: 30_000 });
    expect(await stored(win, made)).toMatchObject({ name: 'Perovskite stability, arXiv', is_active: true });
    await api(win, 'POST', `/api/routines/${made}/deactivate`);

    // — a schedule the choices cannot state is kept, with what is not shown ---
    await win.evaluate((id) => { window.location.hash = `#/watches/${id}/edit`; }, firehose.id);
    await expect(win.locator('[data-editor="schedule"]')).toHaveAttribute('data-cadence', 'kept', { timeout: 30_000 });
    await expect(win.getByRole('button', { name: 'As it is', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(win.locator('[data-will="schedule"] p').first()).toHaveText('Every 15 minutes, in this computer’s time.');
    await win.locator('#watch-intent').fill('Every perovskite preprint, as it appears');
    await win.getByRole('button', { name: 'Save changes' }).click();
    await expect(win.locator('.watch-page [data-editor="said"]')).toHaveText('Saved.', { timeout: 30_000 });
    row = await stored(win, firehose.id);
    expect(row).toMatchObject({ schedule_cron: '*/15 * * * *', intent: 'Every perovskite preprint, as it appears' });
    expect(row.parameters).toMatchObject({ some_future_field: 'kept', max_results: 20 });

    // — a watch on bioRxiv saved with no start says so, and is given one ------
    await win.evaluate((id) => { window.location.hash = `#/watches/${id}`; }, undated.id);
    await expect(win.locator('[data-watch="window"]')).toContainText(
      'Every run asks each source with no date limit, in the source’s own order, except bioRxiv, which needs a start date: '
      + 'each run asks it for the 3 days before it starts.', { timeout: 30_000 });
    await win.locator('[data-watch="window"]').screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-watch-start-default.png') });
    await win.evaluate((id) => { window.location.hash = `#/watches/${id}/edit`; }, undated.id);
    await expect(win.getByRole('radio', { name: 'No date limit' })).toBeChecked({ timeout: 30_000 });
    await expect(win.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    await win.locator('[data-editor="start-offer"]').click();
    await win.getByRole('button', { name: 'Save changes' }).click();
    await expect(win.locator('.watch-page [data-editor="said"]')).toHaveText('Saved.', { timeout: 30_000 });
    expect((await stored(win, undated.id)).parameters).toMatchObject({ date_window: { last_days: 3 }, date_from: '', date_to: '' });
    await expect(win.locator('[data-watch="window"]')).not.toContainText('except bioRxiv');

    // — a person, from their page --------------------------------------------
    await win.evaluate((id) => { window.location.hash = `#/watches/people/${id}`; }, person.id);
    await win.locator('[data-people="watch-for"]').click();
    await expect(win.locator('#watch-name')).toHaveValue('New papers by Ada Fixture', { timeout: 30_000 });
    await expect(win.getByLabel('A person: their new papers')).toBeChecked();
    await expect(win.locator('#watch-person')).toHaveValue(String(person.id));
    await expect(win.locator('[data-editor="person-basis"]')).toContainText('no ORCID');
    await win.locator('.source[data-source="biorxiv"] input').check();
    // bioRxiv cannot be asked about an author, so this watch would find nothing.
    await expect(win.locator('[data-will="unaskable"]')).toBeVisible();
    await win.locator('.source[data-source="arxiv"] input').check();
    await expect(win.locator('[data-will="unaskable"]')).toHaveCount(0);
    // A watch on retractions searches no source for papers, and says what its
    // lifecycle check does send, and to whom; then back to new papers.
    await win.getByLabel('A person: retractions and corrections on their papers').check();
    await expect(win.locator('[data-editor="no-sources"]')).toContainText('the DOIs of the papers already matched to this person to Crossref');
    await expect(win.locator('[data-will="retractions"]')).toContainText('matched to Ada Fixture to Crossref, and the ids of those from arXiv and bioRxiv');
    await expect(win.locator('[data-editor="window"]')).toHaveCount(0);
    await win.getByLabel('A person: their new papers').check();
    await win.locator('[data-switch="is_active"]').click();
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-watch-editor-person.png') });
    await win.getByRole('button', { name: 'Save watch' }).click();
    await expect(win.locator('.watch-page [data-editor="said"]')).toContainText('Saved, paused.', { timeout: 30_000 });
    row = await stored(win, idFrom(win.url()));
    expect(row.parameters).toMatchObject({
      entity: { profile_id: person.id, mode: 'new_papers' }, keywords: [], query: '', repositories: ['biorxiv', 'arxiv'],
    });

    // — where its reports go -------------------------------------------------
    await win.evaluate((id) => { window.location.hash = `#/watches/${id}`; }, made);
    await win.getByRole('tab', { name: 'Where reports go' }).click();
    const add = win.locator('form.destination-add');
    await add.getByLabel('Kind of destination').selectOption({ label: 'Folder' });
    await add.getByLabel('Where it goes').fill(path.join(stateDir, 'out'));
    await add.getByRole('button', { name: 'Add' }).click();
    const folder = win.locator('.destinations li[data-channel="folder"]');
    await expect(folder).toContainText(path.join(stateDir, 'out'), { timeout: 30_000 });
    await add.getByLabel('Kind of destination').selectOption({ label: 'Webhook' });
    await add.getByLabel('Where it goes').fill('https://example.org/resmon-hook');
    await add.getByRole('button', { name: 'Add' }).click();
    const hook = win.locator('.destinations li[data-channel="webhook"]');
    await expect(hook.locator('[data-secret]')).toHaveAttribute('data-secret', 'absent', { timeout: 30_000 });
    await hook.locator('input[type="password"]').fill(SECRET);
    await hook.getByRole('button', { name: 'Store' }).click();
    await expect(hook.locator('[data-secret]')).toHaveAttribute('data-secret', 'present', { timeout: 30_000 });
    await expect(hook.locator('input[type="password"]')).toHaveValue('');
    expect(await win.locator('body').innerText()).not.toContain(SECRET);

    await folder.locator('[data-switch="destination"]').click();
    await expect(folder).toHaveAttribute('data-enabled', 'false', { timeout: 30_000 });
    await hook.getByLabel(/^When reports go to/).selectOption('review');
    await expect.poll(async () => {
      const t = await api<{ targets: { channel: string; enabled: number; mode: string }[] }>(win, 'GET', `/api/routines/${made}/delivery-targets`);
      return t.targets.map((x) => `${x.channel}:${x.enabled}:${x.mode}`).sort();
    }, { timeout: 30_000 }).toEqual(['folder:0:automatic', 'webhook:1:review']);
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-watch-destinations.png') });

    // What it will do: the webhook with its secret, after review; not the folder
    // turned off; and a webhook with no secret named as failing, not as a destination.
    await api(win, 'POST', `/api/routines/${made}/delivery-targets`, { channel: 'webhook', target: 'https://lab.example.org/unsigned' });
    await win.evaluate((id) => { window.location.hash = `#/watches/${id}/edit`; }, made);
    await expect(win.locator('[data-will="finish"]')).toContainText('An email with the report, and its results attached, to the address in Settings.', { timeout: 30_000 });
    await expect(win.locator('[data-will="destination"]')).toHaveText(['Webhook: https://example.org/resmon-hook, after you release each report.']);
    await expect(win.locator('[data-will="unsigned"]')).toHaveText(
      'Webhook: https://lab.example.org/unsigned has no shared secret stored, so each delivery to it will fail until one is.');

    await win.evaluate((id) => { window.location.hash = `#/watches/${id}`; }, made);
    await win.getByRole('tab', { name: 'Where reports go' }).click();
    for (const url of ['https://example.org/resmon-hook', 'https://lab.example.org/unsigned']) {
      await win.locator('.destinations li[data-channel="webhook"]').filter({ hasText: url }).getByRole('button', { name: 'Remove' }).click();
      await expect(win.locator('.destinations li[data-channel="webhook"]').filter({ hasText: url })).toHaveCount(0, { timeout: 30_000 });
    }

    // — begun from a search ----------------------------------------------------
    await win.evaluate(() => { window.location.hash = '#/search/saved'; });
    await win.locator('li.saved[data-kind="manual_sweep"] [data-saved="make-watch"]').click();
    await expect(win.locator('#watch-name')).toHaveValue('Tandem cells, two servers', { timeout: 30_000 });
    await expect(win.locator('.term')).toHaveText(['tandem']);
    await expect(win.locator('.source[data-source="biorxiv"] input')).toBeChecked();
    await expect(win.getByLabel('Most papers per source')).toHaveValue('40');
    // Not its dates: a window fixed when it was saved would be asked on every run.
    await expect(win.getByRole('radio', { name: 'Papers published since the previous run' })).toBeChecked();
    await expect(win.locator('.ask-window input[type="date"]')).toHaveCount(0);
    await win.evaluate(() => { window.location.hash = '#/search/ask'; });
    await win.locator('#ask-terms').fill('perovskite');
    await win.keyboard.press('Enter');
    await win.locator('.source[data-source="arxiv"] input').check();
    await win.locator('[data-editor="watch-this"]').click();
    await expect(win.locator('.term')).toHaveText(['perovskite'], { timeout: 30_000 });
    await expect(win.locator('.source[data-source="arxiv"] input')).toBeChecked();

    // — deleted ---------------------------------------------------------------
    await win.evaluate((id) => { window.location.hash = `#/watches/${id}/edit`; }, made);
    await win.locator('[data-editor="delete"]').click();
    await expect(win.locator('[data-editor="said"]')).toContainText('Deleted “Perovskite stability, arXiv”.', { timeout: 30_000 });
    const names = (await api<{ name: string }[]>(win, 'GET', '/api/routines')).map((r) => r.name);
    expect(names).not.toContain('Perovskite stability, arXiv');
    expect(names).toContain('Preprint firehose');

    expect(problems).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
