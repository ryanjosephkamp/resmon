/**
 * Atlas: a run saved as a search from its own page, and that saved search
 * changed in place on Search › Saved, in the real app.
 *
 * What a person would have before they arrive is seeded: a finished Deep
 * Sweep (two sources, two terms, a fixed window and a cap, set to summarize
 * each paper), and one paused watch, made over the API, so Saved has a
 * watch's copy to show. Then what a person does, with the controls
 * themselves: on the run's page, Save as a search; on Saved, Change it (a new
 * name, a term taken out and another added, a source added, other dates and
 * another cap) and Save changes. After each, the engine is read for what it
 * stored: the saved search, the run's link to it, and every field the
 * editor wrote, with what the editor does not show (that it summarizes)
 * kept. A watch's copy offers the watch's own editor instead.
 *
 * The journey J21 drives Saved's export and import through
 * `journeys/drivers/atlas.ts`. No network is involved: nothing here asks a
 * source.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { FRONTEND_ROOT, SCREENSHOT_DIR, launchEnv, registerStateDir } from './fixtures/resmon-app';

async function api<T>(win: Page, method: string, route: string, body?: unknown): Promise<T> {
  return win.evaluate(async ([m, r, b]) => {
    const port = (window as unknown as { resmonAPI: { getBackendPort(): string } }).resmonAPI.getBackendPort();
    const res = await e2eFetch(`http://127.0.0.1:${port}${r}`, {
      method: m, headers: { 'Content-Type': 'application/json' },
      body: b === undefined ? undefined : JSON.stringify(b),
    });
    if (!res.ok) throw new Error(`${r} answered HTTP ${res.status}: ${await res.text()}`);
    return res.json();
  }, [method, route, body] as const) as Promise<T>;
}

/** A finished Deep Sweep as `prepare_execution` stores one, set to summarize, with a paper from each source. */
const SEED = String.raw`
import json, os, sys
sys.path.insert(0, sys.argv[1])
from implementation_scripts.database import (init_db, get_connection, insert_document, insert_execution,
    link_execution_document, record_execution_source, update_execution_status)
path = os.environ["RESMON_DB_PATH"]
init_db(path)
conn = get_connection(path)
params = {"query": "perovskite tandem", "keywords": ["perovskite", "tandem"], "date_from": "2026-09-01",
          "date_to": "2026-09-30", "max_results": 40, "repositories": ["arxiv", "biorxiv"]}
run = insert_execution(conn, {"execution_type": "deep_sweep", "start_time": "2026-10-28T09:00:00Z",
    "parameters": json.dumps(params)})
for n, source in enumerate(("arxiv", "biorxiv")):
    doc = insert_document(conn, {
        "source_repository": source, "external_id": f"e2e-saved-{n}", "title": f"Perovskite tandem cells {n}",
        "authors": "Ada Fixture", "publication_date": "2026-09-15",
        "abstract": "An authored abstract for the suite, not a published one.", "metadata_hash": f"e2e-saved-{n}",
    })
    link_execution_document(conn, run, doc)
    record_execution_source(conn, run, source, "ok", result_count=1, zero_reason=None)
conn.execute("UPDATE executions SET progress_events = ? WHERE id = ?", (json.dumps([
    {"type": "ai_choice", "enabled": True, "lane_source": "settings", "lanes": [], "adjusted": []},
]), run))
update_execution_status(conn, run, "completed", end_time="2026-10-28T09:00:20Z", result_count=2, new_result_count=2)
conn.commit()
print(json.dumps({"run": run}))
`;

interface Config { id: number; name: string; config_type: string; parameters: Record<string, unknown> }

test('a run saved as a search, and that search changed in place, read back from the engine', async () => {
  test.setTimeout(240_000);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-saved-searches-'));
  const env: Record<string, string> = { ...launchEnv(stateDir, true), RESMON_UI: 'atlas' };
  const seeded = spawnSync(env.RESMON_PYTHON ?? 'python3', ['-c', SEED, path.join(FRONTEND_ROOT, '..')], { env, encoding: 'utf8' });
  expect(seeded.status, seeded.stderr).toBe(0);
  const { run } = JSON.parse(seeded.stdout.trim().split('\n').pop() ?? '{}') as { run: number };

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
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

    // One paused watch, so Saved holds a watch's copy beside the search.
    const watch = await api<{ id: number }>(win, 'POST', '/api/routines', {
      name: 'Perovskite films', schedule_cron: '0 9 * * *', is_active: false,
      parameters: { repositories: ['arxiv'], keywords: ['perovskite'], max_results: 50 },
    });
    const configs = () => api<Config[]>(win, 'GET', '/api/configurations');

    // — the run's page: Save as a search ------------------------------------------
    await win.evaluate((id) => { window.location.hash = `#/runs/${id}`; }, run);
    await expect(win.locator(`.run[data-run="${run}"]`)).toHaveAttribute('data-status', 'completed', { timeout: 60_000 });
    await expect(win.locator('[data-run="saved-search"]')).toHaveCount(0);
    await win.locator('[data-run="save-search"]').click();
    const keep = win.locator('.run-keep');
    await expect(keep).toContainText('Saves this run’s sources, terms, dates, and cap as a search under Saved');
    await expect(keep).toContainText('The search is saved to summarize each paper, as this run was set to.');
    await win.locator('#run-keep-name').fill('Perovskite tandems, September');
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-run-save-search.png') });
    // Enter saves the name.
    await win.locator('#run-keep-name').press('Enter');
    await expect(win.locator('[data-run="kept"]')).toHaveText('Saved as “Perovskite tandems, September”, under Saved.', { timeout: 30_000 });
    await expect(win.locator('[data-run="saved-search"]'))
      .toHaveText('linked to the saved search “Perovskite tandems, September”', { timeout: 30_000 });

    const saved = (await configs()).find((c) => c.name === 'Perovskite tandems, September');
    expect(saved, 'Save as a search stored nothing').toBeTruthy();
    expect(saved!.config_type).toBe('manual_sweep');
    expect(saved!.parameters).toEqual({
      repositories: ['arxiv', 'biorxiv'], keywords: ['perovskite', 'tandem'], date_from: '2026-09-01', date_to: '2026-09-30',
      max_results: 40, ai_enabled: true,
    });
    const linked = await api<{ saved_configuration_id: number | null }>(win, 'GET', `/api/executions/${run}`);
    expect(linked.saved_configuration_id, 'the engine did not link the run to the search saved from it').toBe(saved!.id);

    // — Saved: Change it, in place --------------------------------------------------
    await win.locator('[data-run="kept"] a').click();
    await expect(win.getByRole('heading', { name: 'Saved', level: 1 })).toBeVisible({ timeout: 60_000 });
    const row = win.locator(`li.saved[data-config="${saved!.id}"]`);
    await expect(row.locator('.meta')).toContainText('September 1, 2026 to September 30, 2026');
    await row.locator('[data-saved="change"]').click();
    const editor = row.locator('[data-saved="editor"]');
    await expect(editor).toBeVisible();
    // It opens on what the engine stores.
    await expect(editor.getByLabel('Name', { exact: true })).toHaveValue('Perovskite tandems, September');
    await expect(editor.locator('.term')).toHaveText(['perovskite', 'tandem']);
    await expect(editor.locator('.source[data-source="arxiv"] input')).toBeChecked();
    await expect(editor.locator('.source[data-source="biorxiv"] input')).toBeChecked();

    // Nothing is saved without a name; the button says why.
    await editor.getByLabel('Name', { exact: true }).fill(' ');
    await expect(editor.locator('[data-saved="save-changes"]')).toBeDisabled();
    await expect(editor.locator('[data-saved="problem"]')).toHaveText('Give it a name.');

    await editor.getByLabel('Name', { exact: true }).fill('Perovskite tandems, autumn');
    await editor.getByRole('button', { name: 'Remove tandem' }).click();
    await editor.getByLabel('Search terms').fill('stability');
    await editor.getByLabel('Search terms').press('Enter');
    await editor.locator('.source[data-source="crossref"] input').check();
    await editor.locator('input[type="date"]').first().fill('2026-10-01');
    await editor.locator('input[type="date"]').last().fill('2026-10-28');
    await editor.getByLabel('Most papers per source').fill('25');
    await row.scrollIntoViewIfNeeded();
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-saved-change.png') });
    const put = win.waitForResponse((r) => /\/api\/configurations\/\d+$/.test(r.url()) && r.request().method() === 'PUT');
    await editor.locator('[data-saved="save-changes"]').click();
    expect((await put).ok()).toBe(true);
    await expect(row.locator('[data-saved="changed"]')).toHaveText('Saved the changes to “Perovskite tandems, autumn”.', { timeout: 30_000 });
    await expect(editor).toHaveCount(0);

    // The same row, changed: no second saved search, and every field as the editor left it.
    const after = await configs();
    expect(after.filter((c) => c.config_type !== 'routine').map((c) => c.id), 'Save changes made a new saved search').toEqual([saved!.id]);
    const changed = after.find((c) => c.id === saved!.id)!;
    expect(changed.name).toBe('Perovskite tandems, autumn');
    expect(changed.config_type).toBe('manual_sweep');
    expect(changed.parameters).toEqual({
      repositories: ['arxiv', 'biorxiv', 'crossref'], keywords: ['perovskite', 'stability'], date_from: '2026-10-01',
      date_to: '2026-10-28', max_results: 25, ai_enabled: true,
    });
    // The row is drawn from what the engine now holds.
    await expect(row.locator('.saved-name')).toHaveText('Perovskite tandems, autumn');
    await expect(row.locator('.meta')).toContainText('“perovskite stability”');
    await expect(row.locator('.meta')).toContainText('October 1, 2026 to October 28, 2026');
    await expect(row.locator('.meta')).toContainText('up to 25 per source');

    // — a watch's copy is changed in the watch's own editor -----------------------------
    const copy = win.locator('li.saved[data-kind="routine"]');
    await expect(copy).toHaveCount(1);
    await expect(copy.locator('[data-saved="change"]')).toHaveCount(0);
    await expect(copy.locator('[data-saved="change-watch"]')).toHaveAttribute('href', `#/watches/${watch.id}/edit`);
    await expect(win.locator('.page-lede')).toContainText('A watch’s copy follows the watch');
    await copy.locator('[data-saved="change-watch"]').click();
    await expect(win.locator('.watch-editor')).toBeVisible({ timeout: 30_000 });
    expect(await win.evaluate(() => window.location.hash)).toBe(`#/watches/${watch.id}/edit`);

    // — the run names the search by the name it has now ---------------------------------
    await win.evaluate((id) => { window.location.hash = `#/runs/${id}`; }, run);
    await expect(win.locator('[data-run="saved-search"]'))
      .toHaveText('linked to the saved search “Perovskite tandems, autumn”', { timeout: 30_000 });

    expect(problems).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
