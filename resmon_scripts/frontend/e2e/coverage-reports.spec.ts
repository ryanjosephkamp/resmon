/** Authored histories and real controlled transport reach the actual Electron viewer. */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { test, expect, _electron as electron } from '@playwright/test';
import { FRONTEND_ROOT, launchEnv, ensureScreenshotDir } from './fixtures/resmon-app';
import { launchSourceApp, sourceApi } from './fixtures/source-boundary';

test('coverage history opens with keyboard, exports and preserves source identity and corpus', async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-coverage-'));
  const env = launchEnv(state, true);
  env.RESMON_DISABLE_SCHEDULER = '1';
  env.PYTHON_KEYRING_BACKEND = 'keyring.backends.null.Keyring';
  const helper = path.resolve(FRONTEND_ROOT, '../verification_scripts/test_coverage_reports.py');
  const fixture = JSON.parse(execFileSync(env.RESMON_PYTHON, [helper, 'seed', env.RESMON_DB_PATH], { env, encoding: 'utf8' })) as { coverage_ids: Record<string, number>; marker: string };
  const snapshot = () => execFileSync(env.RESMON_PYTHON, [helper, 'snapshot', env.RESMON_DB_PATH], { env, encoding: 'utf8' });
  const before = snapshot();
  const app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(state, 'electron-user-data')}`], cwd: FRONTEND_ROOT, env, timeout: 180_000 });
  let backendPid = 0;
  try {
    const win = await app.firstWindow({ timeout: 180_000 });
    await win.locator('.app-main').waitFor({ state: 'visible', timeout: 60_000 });
    const health = await sourceApi(win, '/api/health');
    backendPid = Number(health.pid);
    const port = fs.readFileSync(env.RESMON_PORT_FILE, 'utf8').trim();
    expect(port).not.toBe('8742');
    expect(Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(backendPid)], { encoding: 'utf8' }).trim())).toBe(app.process().pid);
    console.log('COVERAGE_INSTANCE', JSON.stringify({ state, port, health, parentPid: app.process().pid, source: FRONTEND_ROOT, database: env.RESMON_DB_PATH, reports: env.RESMON_REPORTS_DIR, profile: path.join(state, 'electron-user-data'), fixture }));
    await win.evaluate(() => { window.location.hash = '#/results'; });
    const mixed = fixture.coverage_ids.mixed;
    await win.getByText(`Execution #${mixed}`, { exact: true }).locator('xpath=ancestor::tr').click();
    const summary = win.locator('.report-viewer > .coverage-summary');
    await expect(summary).toContainText('6 selected sources: 2 answered');
    await expect(summary).toContainText('2 unknown');
    const open = summary.getByRole('button', { name: 'View source details' });
    await open.focus(); await win.keyboard.press('Enter');
    await expect(win.locator('.tab-bar .tab-active')).toHaveText('Search record');
    await expect(win.locator('.tab-bar .tab-active')).toBeFocused();
    await expect(win.locator('.search-record')).toContainText('Outcome not recorded');
    await expect(win.locator('.search-record')).toContainText('could not read the reply');
    await expect(win.locator('.tab-bar .tab-btn')).toHaveCount(6);
    await win.screenshot({ path: path.join(ensureScreenshotDir(), 'coverage-mixed.png') });
    await win.getByRole('button', { name: 'Export', exact: true }).click();
    await expect(win.getByText(/Export saved to:/)).toBeVisible();
    const exported = (await win.getByText(/Export saved to:/).innerText()).replace('Export saved to: ', '').trim();
    const zip = JSON.parse(execFileSync(env.RESMON_PYTHON, ['-c', 'import zipfile,json,sys; z=zipfile.ZipFile(sys.argv[1]); print(z.read(sys.argv[2]).decode())', exported, `execution_${mixed}/search-record.json`], { env, encoding: 'utf8' })) as { search: { execution_id: number }; coverage: { counts: { unknown: number } } };
    expect(zip.search.execution_id).toBe(mixed); expect(zip.coverage.counts.unknown).toBe(2);
    await win.getByRole('button', { name: 'Close', exact: true }).click();
    const empty = fixture.coverage_ids['no-history'];
    await win.getByText(`Execution #${empty}`, { exact: true }).locator('xpath=ancestor::tr').click();
    await expect(summary).toContainText('No source outcomes were recorded');
    await expect(summary).toContainText(`Execution #${empty}`);
    await expect(win.getByText(/Export saved to:/)).toHaveCount(0);
    await win.getByRole('button', { name: 'Close', exact: true }).click();
    await win.evaluate(id => { window.location.hash = `#/results?exec=${id}&tab=record`; }, mixed);
    // Missing record is an actual backend 404, not an empty-success response.
    const missing = await win.request.get(`http://127.0.0.1:${port}/api/executions/999999/search-record`);
    expect(missing.status()).toBe(404);
    expect(snapshot()).toBe(before);
    console.log('COVERAGE_UI', JSON.stringify({ mixed, empty, exported, sixTabs: true, keyboardDetails: true, corpusUnchanged: true }));
  } finally {
    await app.close();
    if (backendPid) await expect.poll(() => { try { process.kill(backendPid, 0); return true; } catch { return false; } }).toBe(false);
    console.log('COVERAGE_SHUTDOWN', JSON.stringify({ state, backendPid, appExitCode: app.process().exitCode, backendExited: true }));
    fs.rmSync(state, { recursive: true, force: true });
  }
});

for (const mode of ['503', 'malformed'] as const) {
  test(`real source ${mode} reaches coverage as a recorded non-answer, never genuine empty`, async () => {
    const source = await launchSourceApp(mode);
    try {
      const { win } = source;
      const id = await win.evaluate(async () => {
        const port = (window as unknown as { resmonAPI: { getBackendPort(): string } }).resmonAPI.getBackendPort();
        if (!port || port === '8742') throw new Error('unidentified backend');
        const response = await fetch(`http://127.0.0.1:${port}/api/search/dive`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repository: 'arxiv', query: 'coverage fixture', max_results: 3, ai_enabled: false }) });
        if (!response.ok) throw new Error(`search failed ${response.status}`);
        return (await response.json()).execution_id as number;
      });
      await source.waitForRequest(); source.release();
      await expect.poll(async () => (await sourceApi(win, `/api/executions/${id}`)).status, { timeout: 90_000 }).toBe('completed');
      const effect = source.evidence(id);
      expect(effect.stored.sources[0].zero_reason).toBe(mode === '503' ? 'upstream_failure' : 'parse_failure');
      expect(effect.requests.every(r => r.status === (mode === '503' ? 503 : 200))).toBe(true);
      const record = await sourceApi(win, `/api/executions/${id}/search-record`);
      expect(record.coverage).toMatchObject({ counts: { answered: 0, non_answer: 1, unknown: 0, genuine_empty: 0 } });
      await win.evaluate(() => { window.location.hash = '#/results'; });
      await win.getByText(`Execution #${id}`, { exact: true }).locator('xpath=ancestor::tr').click();
      await expect(win.locator('.report-viewer > .coverage-summary')).toContainText('1 recorded non-answer');
      await expect(win.locator('.report-viewer > .coverage-summary')).toContainText('Genuine empty answers: 0');
      console.log('COVERAGE_TRANSPORT', JSON.stringify({ mode, id, coverage: record.coverage }));
    } finally { await source.close(); }
  });
}
