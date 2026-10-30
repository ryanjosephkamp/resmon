/**
 * Atlas: what happens to runs, in the real app. How many run at once, set in
 * Settings › In the background and then met by a search; the upload after
 * each run, switched on in Settings › Cloud Storage with nothing connected;
 * and the run log's selection, bundled and deleted, with a run still going
 * left alone, and a run deleted from its own page.
 *
 * arXiv is a loopback server in this spec. It answers each query with one
 * authored paper named for the query, and holds a query for "slow" open until
 * the spec lets it go, so a run can be seen while it is still running. Every
 * other connection the engine tries, and port 8742, is refused by the startup
 * hook, and the spec fails if anything was: nothing here signs in to Google
 * or uploads anything, and the run's log is where the skipped upload is read.
 *
 * The runs a person would already have are started over the API; everything
 * the spec checks is done with the controls themselves, and then read back
 * from the engine.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { FRONTEND_ROOT, REPO_ROOT, SCREENSHOT_DIR, launchEnv, registerStateDir } from './fixtures/resmon-app';

const feed = (term: string) => `<feed xmlns="http://www.w3.org/2005/Atom"><entry>
  <id>https://arxiv.org/abs/2610.${term.length}${term.charCodeAt(0)}v1</id><title>Authored Atlas runs fixture on ${term}</title>
  <author><name>Ada Fixture</name></author><published>${new Date().toISOString().slice(0, 10)}T00:00:00Z</published>
  <summary>Authored local fixture, not fetched scholarly content.</summary>
</entry></feed>`;

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

interface RunRead { id: number; status: string; result_path: string | null; log_path: string | null }

test('runs: how many at once, the upload after each, and the log\'s selection bundled and deleted', async () => {
  test.setTimeout(300_000);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-runs-'));
  const held: http.ServerResponse[] = [];
  let holding = true;
  const source = http.createServer((req, res) => {
    const query = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('search_query') ?? '');
    const term = /all:(\w+)/.exec(query)?.[1] ?? 'nothing';
    res.writeHead(200, { 'Content-Type': 'application/atom+xml' });
    if (term === 'slow' && holding) held.push(res);
    else res.end(feed(term));
  });
  const release = () => {
    holding = false;
    for (const res of held.splice(0)) res.end(feed('slow'));
  };
  await new Promise<void>((resolve) => source.listen(0, '127.0.0.1', resolve));
  const sourcePort = (source.address() as net.AddressInfo).port;
  expect(sourcePort).not.toBe(8742);

  const hookDir = path.join(stateDir, 'python-hook');
  fs.mkdirSync(hookDir);
  fs.writeFileSync(path.join(hookDir, 'sitecustomize.py'), `
import ipaddress, json, socket, sys
from pathlib import Path
state = Path(${JSON.stringify(stateDir)})
original_connect = socket.socket.connect
def connect(self, address):
    if isinstance(address, tuple):
        host, port = address[:2]
        try: local = ipaddress.ip_address(host).is_loopback
        except ValueError: local = host == 'localhost'
        if not local or port == 8742:
            with (state / 'blocked.jsonl').open('a') as stream:
                stream.write(json.dumps({'host': host, 'port': port}) + "\\n")
            raise OSError('atlas-runs test guard refuses external/8742 connection')
    return original_connect(self, address)
socket.socket.connect = connect
sys.path.insert(0, ${JSON.stringify(path.join(REPO_ROOT, 'resmon_scripts'))})
from implementation_scripts import api_arxiv, config
api_arxiv._ARXIV_API_URL = ${JSON.stringify(`http://127.0.0.1:${sourcePort}/api/query`)}
# The held query is let go by the spec, never by a timeout.
config.DEFAULT_REQUEST_TIMEOUT = 240
`);
  const env: Record<string, string> = { ...launchEnv(stateDir, true), RESMON_UI: 'atlas' };
  env.PYTHONPATH = [hookDir, env.PYTHONPATH].filter(Boolean).join(path.delimiter);
  env.NO_PROXY = env.no_proxy = '127.0.0.1,localhost';

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

    // — In the background: runs at once, and the watch runs that can wait ----
    await win.evaluate(() => { window.location.hash = '#/settings/background'; });
    const limits = win.locator('[data-limits="group"]');
    await expect(limits).toHaveAttribute('aria-busy', 'false', { timeout: 60_000 });
    await expect(win.locator('#limit-runs')).toHaveValue('3');
    await expect(win.locator('#limit-queue')).toHaveValue('16');
    // No service runs here, so the window's own engine takes the change, and
    // the screen says the service reads it only when it starts.
    await expect(limits.locator('[data-limits="reach"]')).toContainText('an engine it started itself, so a change applies to that engine at once');
    await expect(limits.locator('[data-limits="reach"]')).toContainText('reads these limits when it starts');
    await win.locator('#limit-runs').fill('0');
    await expect(limits.getByRole('alert')).toHaveText('Runs at once must be a whole number from 1 to 8.');
    await expect(limits.locator('[data-limits="save"]')).toBeDisabled();
    await win.locator('#limit-runs').fill('1');
    await win.locator('#limit-queue').fill('5');
    const putLimits = win.waitForResponse((r) => r.url().endsWith('/api/settings/execution') && r.request().method() === 'PUT');
    await limits.locator('[data-limits="save"]').click();
    expect((await putLimits).ok()).toBe(true);
    await expect(limits.locator('[data-limits="saved"]')).toHaveText('Saved.');
    expect((await engine<Record<string, number>>(win, '/api/settings/execution')).body)
      .toMatchObject({ max_concurrent_executions: 1, routine_fire_queue_limit: 5 });
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-settings-run-limits.png') });
    await win.reload();
    await expect(win.locator('#limit-runs')).toHaveValue('1', { timeout: 60_000 });
    await expect(win.locator('#limit-queue')).toHaveValue('5');

    // — Cloud Storage: the upload after each run, on with nothing connected ---
    await win.evaluate(() => { window.location.hash = '#/settings/cloud'; });
    await expect(win.locator('[data-cloud="state"]')).toContainText('Not connected', { timeout: 30_000 });
    const after = win.locator('[role="switch"][data-switch="cloud_auto_backup"]');
    await expect(after).toHaveAttribute('aria-checked', 'false');
    await expect(win.locator('[data-cloud="auto-state"]')).toHaveCount(0);
    const putCloud = () => win.waitForResponse((r) => r.url().endsWith('/api/settings/cloud') && r.request().method() === 'PUT');
    let savedCloud = putCloud();
    await after.click();
    expect((await savedCloud).ok()).toBe(true);
    await expect(after).toHaveAttribute('aria-checked', 'true');
    expect((await engine<{ cloud_auto_backup: string }>(win, '/api/settings/cloud')).body.cloud_auto_backup).toBe('true');
    await expect(win.locator('[data-cloud="auto-state"]'))
      .toHaveText('On, but Google Drive is not connected, so each run skips the upload and its log says so.');
    // Not a claim this tab can keep: it uploads reports, not the database or the vault.
    expect(/backs? up your database|Library vault/i.test(await win.locator('main.stage').innerText())).toBe(false);
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-settings-cloud-after-each-run.png') });
    await win.reload();
    await expect(after).toHaveAttribute('aria-checked', 'true', { timeout: 60_000 });

    // — The runs a person already has: two finished, one still going ---------
    const dive = async (term: string): Promise<number> => {
      const started = await engine<{ execution_id: number }>(win, '/api/search/dive', 'POST', {
        repository: 'arxiv', query: term, keywords: [term], max_results: 5,
      });
      expect(started.status, JSON.stringify(started.body)).toBe(200);
      return started.body.execution_id;
    };
    const settled = (id: number) => expect.poll(async () => (await engine<RunRead>(win, `/api/executions/${id}`)).body.status,
      { timeout: 60_000 }).not.toBe('running');
    const alpha = await dive('alpha');
    await settled(alpha);
    const beta = await dive('beta');
    await settled(beta);
    const slow = await dive('slow');
    await expect.poll(() => held.length, { timeout: 30_000 }).toBe(1);
    const alphaRun = (await engine<RunRead>(win, `/api/executions/${alpha}`)).body;
    expect(alphaRun.status).toBe('completed');
    expect(alphaRun.result_path && fs.existsSync(alphaRun.result_path), 'the finished run wrote no report').toBe(true);

    // — One run at once: a search asked while one runs is refused -----------
    await win.evaluate(() => { window.location.hash = '#/search/ask'; });
    await expect(win.getByRole('heading', { name: 'Ask the sources', level: 1 })).toBeVisible({ timeout: 60_000 });
    await win.getByRole('button', { name: 'Deep Sweep', exact: true }).click();
    await win.locator('.source[data-source="arxiv"] input').check();
    const terms = win.getByLabel('Search terms');
    await terms.fill('refused');
    await terms.press('Enter');
    const asked = win.waitForResponse((r) => r.url().endsWith('/api/search/sweep') && r.request().method() === 'POST');
    await win.getByRole('button', { name: 'Ask arXiv', exact: true }).click();
    expect((await asked).status()).toBe(429);
    await expect(win.locator('.ask-refusal'))
      .toHaveText('resmon is already running as many runs at once as Settings › In the background allows. Try again when one finishes.');
    expect((await engine<RunRead[]>(win, '/api/executions')).body.map((r) => r.id).sort((a, b) => a - b)).toEqual([alpha, beta, slow]);

    // — The log's selection: bundled, then deleted with the running one left --
    const row = (id: number) => win.locator(`.run-row[data-run="${id}"]`);
    await expect(row(slow).locator('.run-status')).toHaveAttribute('data-status', 'running', { timeout: 30_000 });
    await row(alpha).getByRole('checkbox', { name: `Select run ${alpha}` }).check();
    await row(beta).getByRole('checkbox', { name: `Select run ${beta}` }).check();
    const bar = win.getByRole('group', { name: 'The selected runs' });
    await expect(bar).toContainText('2 runs: export their papers as');

    const bundleFile = path.join(stateDir, 'atlas-runs-bundle.zip');
    let askedTheEngineToWrite = false;
    win.on('request', (r) => { if (r.url().endsWith('/api/executions/export')) askedTheEngineToWrite = true; });
    await app.evaluate(({ BrowserWindow }, target) => {
      BrowserWindow.getAllWindows()[0].webContents.session.once('will-download', (_e, item) => {
        item.setSavePath(target as string);
      });
    }, bundleFile);
    await bar.locator('[data-runs="bundle"]').click();
    await expect.poll(() => (fs.existsSync(bundleFile) ? fs.statSync(bundleFile).size : 0), { timeout: 60_000 }).toBeGreaterThan(0);
    const members = JSON.parse(execFileSync(env.RESMON_PYTHON ?? 'python3', ['-c', `
import json, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    assert z.testzip() is None
    print(json.dumps({"names": z.namelist(), "manifest": json.loads(z.read("manifest.json"))}))
`, bundleFile], { encoding: 'utf8' })) as { names: string[]; manifest: { id: number }[] };
    expect(members.manifest.map((m) => m.id)).toEqual([alpha, beta]);
    for (const id of [alpha, beta]) {
      expect(members.names, `the bundle has no search record for run ${id}`).toContain(`execution_${id}/search-record.md`);
      expect(members.names.some((m) => m.startsWith(`execution_${id}/`) && m.endsWith('.md') && !m.endsWith('search-record.md')),
        `the bundle carries no report for run ${id}`).toBe(true);
    }
    expect(askedTheEngineToWrite, 'the bundle went through the route that writes where the engine chooses').toBe(false);

    await row(slow).getByRole('checkbox', { name: `Select run ${slow}` }).check();
    await expect(bar).toContainText('3 runs: export their papers as');
    await expect(bar.locator('[data-runs="still-running"]'))
      .toHaveText(`Run ${slow} is still running. A run can be deleted once it has stopped.`);
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-runlog-selected.png') });

    const questions: string[] = [];
    win.once('dialog', (d) => { questions.push(d.message()); void d.accept(); });
    const deletes: string[] = [];
    win.on('request', (r) => { if (r.method() === 'DELETE' && r.url().includes('/api/executions/')) deletes.push(r.url()); });
    await bar.locator('[data-runs="delete"]').click();
    await expect.poll(() => questions.length).toBe(1);
    expect(questions[0]).toBe(
      `Delete 2 runs (runs ${alpha} and ${beta})? resmon deletes their records, with each one’s line in the run log, what each `
      + 'source answered, which papers it found, and where its report was sent. The papers stay in your collection, and '
      + `their report and log files stay in the reports folder. Run ${slow} is still running, and is not deleted. This `
      + 'cannot be undone.',
    );
    // Gone from the log as soon as the engine has said so, without waiting for the log's next read.
    await expect(row(alpha)).toHaveCount(0, { timeout: 5_000 });
    await expect(row(beta)).toHaveCount(0, { timeout: 5_000 });
    await expect(win.locator('[data-runs="deleted"] [role="status"]')).toHaveText('Deleted 2 runs.');
    await expect(row(slow)).toBeVisible();
    await expect(row(slow).getByRole('checkbox')).toBeChecked();
    await expect(bar).toContainText('1 run: export their papers as');
    await expect(bar.locator('[data-runs="delete"]')).toBeDisabled();
    expect(deletes.filter((url) => url.endsWith(`/api/executions/${slow}`)), 'the running run was sent to be deleted').toEqual([]);
    // What the engine did: the two records are gone, the third and the files are not.
    expect((await engine(win, `/api/executions/${alpha}`)).status).toBe(404);
    expect((await engine(win, `/api/executions/${beta}`)).status).toBe(404);
    expect((await engine<RunRead[]>(win, '/api/executions')).body.map((r) => r.id)).toEqual([slow]);
    expect(fs.existsSync(alphaRun.result_path ?? ''), 'deleting the run deleted its report file').toBe(true);
    expect(fs.existsSync(alphaRun.log_path ?? ''), 'deleting the run deleted its log file').toBe(true);
    // And the papers they found stay in the collection: one each, and the slow run's is not stored yet.
    const corpus = await engine<{ total: number }>(win, '/api/explorer/search', 'POST', { page: 1, page_size: 1 });
    expect(corpus.body.total).toBe(2);

    // — A run's own page: nothing to delete while it runs, then deleted -----
    await row(slow).locator('.run-title').click();
    const page = win.locator(`.run[data-run="${slow}"]`);
    await expect(page).toHaveAttribute('data-status', 'running', { timeout: 30_000 });
    await expect(page.locator('[data-run="delete"]')).toHaveCount(0);
    release();
    await expect(page).toHaveAttribute('data-status', 'completed', { timeout: 60_000 });

    // The upload after the run was skipped, and its log says why. Nothing
    // reached Google: the guard's file is checked at the end.
    await expect.poll(async () => (await engine<{ log_text: string }>(win, `/api/executions/${slow}/log`)).body?.log_text ?? '',
      { timeout: 30_000 }).toContain('Auto-backup skipped: Google Drive is not connected.');
    await win.getByRole('tab', { name: 'Log' }).click();
    await expect(win.locator('.record-text.is-log')).toContainText('Auto-backup skipped: Google Drive is not connected.', { timeout: 30_000 });

    const remove = page.locator('[data-run="delete"]');
    await expect(remove).toHaveText('Delete this run');
    win.once('dialog', (d) => { questions.push(d.message()); void d.dismiss(); });
    await remove.click();
    await expect.poll(() => questions.length).toBe(2);
    expect(questions[1]).toMatch(new RegExp(`^Delete run ${slow}, “slow”\\? resmon deletes its record, with `));
    expect(questions[1]).toContain('its report and log files stay in the reports folder. This cannot be undone.');
    await expect(page).toBeVisible();
    expect((await engine(win, `/api/executions/${slow}`)).status, 'a dismissed question deleted the run').toBe(200);

    win.once('dialog', (d) => { questions.push(d.message()); void d.accept(); });
    await remove.click();
    await expect(win.getByRole('heading', { name: 'Ask the sources', level: 1 })).toBeVisible({ timeout: 30_000 });
    expect(await win.evaluate(() => window.location.hash)).toBe('#/search/ask');
    await expect(win.locator('[data-runs="deleted"] [role="status"]')).toHaveText(`Deleted run ${slow}.`);
    await expect(row(slow)).toHaveCount(0);
    await expect(win.locator('.runlog .index-empty')).toContainText('No runs yet.');
    expect((await engine(win, `/api/executions/${slow}`)).status).toBe(404);
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-runlog-deleted.png') });

    // — And the upload after each run switched off again --------------------
    await win.evaluate(() => { window.location.hash = '#/settings/cloud'; });
    await expect(after).toHaveAttribute('aria-checked', 'true', { timeout: 30_000 });
    savedCloud = putCloud();
    await after.click();
    expect((await savedCloud).ok()).toBe(true);
    await expect(after).toHaveAttribute('aria-checked', 'false');
    expect((await engine<{ cloud_auto_backup: string }>(win, '/api/settings/cloud')).body.cloud_auto_backup).toBe('false');

    expect(problems).toEqual([]);
  } finally {
    release();
    await app.close();
    await new Promise<void>((resolve) => source.close(() => resolve()));
    const blocked = fs.existsSync(path.join(stateDir, 'blocked.jsonl'))
      ? fs.readFileSync(path.join(stateDir, 'blocked.jsonl'), 'utf8') : '';
    expect(blocked).toBe('');
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
