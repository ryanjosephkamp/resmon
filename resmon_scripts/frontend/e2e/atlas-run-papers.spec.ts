/**
 * Atlas: a run that stored more papers than a page holds, in the real app.
 * The run is written before the app starts, with 2,500 papers. Its map is
 * drawn from every paper's id, read in one request, never from the papers
 * themselves 200 at a time; its Papers tab reads 200, and the next 200 when
 * asked. Before, the map read at most 2,000 papers, 200 at a time, and a run
 * that stored more was drawn as if it had stored 2,000.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test, expect, _electron as electron } from '@playwright/test';
import { FRONTEND_ROOT, REPO_ROOT, SCREENSHOT_DIR, launchEnv, registerStateDir } from './fixtures/resmon-app';
import { removeStateDir } from './fixtures/cleanup';

const PAPERS = 2_500;

test('a run with 2,500 papers: its map counts every one, from one read of their ids, and its papers come a page at a time', async () => {
  test.setTimeout(240_000);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-run-papers-'));
  const env: Record<string, string> = { ...launchEnv(stateDir, true) };
  const seeded = execFileSync(env.RESMON_PYTHON, ['-c', `
import json, sys
sys.path.insert(0, ${JSON.stringify(path.join(REPO_ROOT, 'resmon_scripts'))})
from implementation_scripts import database
conn = database.get_connection(sys.argv[1])
database.init_db(conn=conn)
run = database.insert_execution(conn, {
    "execution_type": "deep_sweep", "status": "running", "start_time": "2026-11-01T09:00:00Z",
    "parameters": json.dumps({"query": "many papers", "keywords": ["many papers"], "repositories": ["arxiv"]}),
})
for n in range(${PAPERS}):
    doc = conn.execute(
        "INSERT INTO documents (source_repository, external_id, title, metadata_hash) VALUES ('arxiv', ?, ?, ?)",
        (f"many-{n}", f"Authored fixture paper {n:04d}", f"many-{n}")).lastrowid
    database.link_execution_document(conn, run, doc, is_new=True)
database.update_execution_status(conn, run, "completed", end_time="2026-11-01T09:05:00Z",
                                 result_count=${PAPERS}, new_result_count=${PAPERS})
conn.commit()
print(run)
`, env.RESMON_DB_PATH], { env, encoding: 'utf8' });
  const runId = Number(seeded.trim().split('\n').pop());
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
    const asked: string[] = [];
    win.on('request', (r) => {
      const url = new URL(r.url());
      if (url.pathname.startsWith(`/api/executions/${runId}/`)) asked.push(`${url.pathname.slice(`/api/executions/${runId}`.length)}${url.search}`);
    });
    await win.evaluate((id) => { window.location.hash = `#/runs/${id}`; }, runId);
    const page = win.locator(`.run[data-run="${runId}"]`);
    await expect(page).toHaveAttribute('data-status', 'completed', { timeout: 60_000 });

    // The map counts all 2,500, whether it has placed them yet or not.
    await expect(page.locator('.run-main .sky figcaption')).toContainText('2,500 papers', { timeout: 60_000 });
    await expect(page.getByRole('button', { name: 'Open the Run’s Own Map' })).toBeVisible();
    // The Papers tab: the first page, and the next when asked.
    await expect(page.locator('.paper-row')).toHaveCount(200, { timeout: 30_000 });
    await expect(page.locator('.run-panel .record-cap')).toHaveText('The first 200 of 2,500 papers this run stored.');
    const more = page.locator('[data-run="more-papers"]');
    await expect(more).toHaveText('More Papers (2,300 More)');
    await more.click();
    await expect(page.locator('.paper-row')).toHaveCount(400);
    await expect(page.locator('.run-panel .record-cap')).toHaveText('The first 400 of 2,500 papers this run stored.');
    // One read of every id for the map, which is the shown collection's; the papers only as the tab asked for
    // them, and one count of the run's new papers (a page of one), for Save this run's new papers.
    expect(asked.filter((a) => a.startsWith('/document-ids'))).toEqual(['/document-ids?collection=1']);
    expect(asked.filter((a) => a.startsWith('/documents?')).sort()).toEqual([
      '/documents?limit=200&offset=0', '/documents?limit=200&offset=200', '/documents?only_new=true&limit=1',
    ]);
    // A find reaches past the pages read: the engine narrows all 2,500, and the header counts the matches.
    const find = page.locator('[data-run="find"]');
    await find.fill('fixture paper 012');
    await expect(page.locator('[data-run="papers-count"]')).toHaveText('10 of 2,500 papers match.', { timeout: 30_000 });
    await expect(page.locator('.paper-row')).toHaveCount(10);
    await expect(page.locator('.paper-row .paper-title').first()).toContainText('Authored fixture paper 012');
    expect(asked.some((a) => new URLSearchParams(a.split('?')[1] ?? '').get('q') === 'fixture paper 012')).toBe(true);
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-run-papers-find.png') });
    // Clearing the find returns to the list as it was left: both pages read before it.
    await find.press('Escape');
    await expect(page.locator('[data-run="papers-count"]')).toHaveText('The first 400 of 2,500 papers this run stored.', { timeout: 30_000 });
    await expect(page.locator('.paper-row')).toHaveCount(400);
    expect(problems).toEqual([]);
  } finally {
    await app.close();
    removeStateDir(stateDir);
  }
});
