import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test, expect, _electron as electron } from '@playwright/test';
import { FRONTEND_ROOT, REPO_ROOT, SCREENSHOT_DIR, launchEnv, registerStateDir } from './fixtures/resmon-app';
import { SEED, engine, mapsEnv } from './fixtures/maps';
import { removeStateDir } from './fixtures/cleanup';

const EXTRA = String.raw`
import random
from implementation_scripts.shared_wording import find_pairs, save_state, _new_state
sources = ['biorxiv', 'medrxiv', 'arxiv', 'crossref']
partial = insert_execution(conn, {'execution_type': 'deep_sweep', 'start_time': fmt(now),
    'parameters': json.dumps({'repositories': sources, 'keywords': ['reader'], 'query': 'reader'})})
for source in sources[:2]:
    record_execution_source(conn, partial, source, 'ok', result_count=50, zero_reason='answered_in_part',
        zero_detail=json.dumps({'detail': 'time_budget', 'read': {'records': 660, 'total': 1824, 'order': 'newest_first',
          'first_date': '2026-10-29', 'last_date': '2026-10-31'}}))
record_execution_source(conn, partial, 'arxiv', 'ok', result_count=1)
record_execution_source(conn, partial, 'crossref', 'error', zero_reason='upstream_failure')
for d in ids['protein']['old'] + ids['quantum']['old']:
    link_execution_document(conn, partial, d)
update_execution_status(conn, partial, 'completed', end_time=fmt(now), result_count=101, new_result_count=0)
rng = random.Random(82)
statement = 'Views and opinions expressed are however those of the authors only and do not necessarily reflect those of the supporting organization or its administrative bodies.'
for i in range(6):
    body = ' '.join('term' + str(rng.randrange(1000000)) for _ in range(90)) + '. ' + statement
    insert_document(conn, {'source_repository': 'arxiv', 'external_id': f'standard-{i}', 'title': f'Distinct study {i}',
      'authors': f'Person{i} Surname{i}', 'abstract': body, 'publication_date': '2026-01-01', 'metadata_hash': f'std-{i}'})
conn.commit()
print(json.dumps({'partial': partial}))
`;

test('source coverage paragraphs, recurring wording exports, and sortable region filters in the desktop app', async () => {
  test.setTimeout(240_000);
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-wording-regions-'));
  const env = mapsEnv(launchEnv(state, true));
  const seeded = spawnSync(env.RESMON_PYTHON!, ['-c', SEED + EXTRA, path.join(REPO_ROOT, 'resmon_scripts')], { env, encoding: 'utf8' });
  expect(seeded.status, seeded.stderr).toBe(0);
  const seed = JSON.parse(seeded.stdout.trim().split('\n').pop()!) as { partial: number };
  const downloads = path.join(state, 'downloads'); fs.mkdirSync(downloads);
  const hook = path.join(state, 'hook'); fs.mkdirSync(hook);
  fs.writeFileSync(path.join(hook, 'sitecustomize.py'), `import socket, ipaddress\nconnect = socket.socket.connect\ndef guarded(self, address):\n    if isinstance(address, tuple):\n        host, port = address[:2]\n        if port == 8742 or not (host == 'localhost' or ipaddress.ip_address(host).is_loopback):\n            raise OSError('Only disposable loopback connections are allowed')\n    return connect(self, address)\nsocket.socket.connect = guarded\n`);
  env.PYTHONPATH = [hook, env.PYTHONPATH].filter(Boolean).join(path.delimiter);
  registerStateDir(state);
  const app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(state, 'profile')}`], cwd: FRONTEND_ROOT,
    env, colorScheme: null, timeout: 180_000 });
  try {
    await app.evaluate(({ shell }) => { shell.openExternal = async () => undefined; });
    const downloadTo = (target: string) => app.evaluate(({ BrowserWindow }, where) => {
      BrowserWindow.getAllWindows()[0]!.webContents.session.once('will-download', (_event, item) => item.setSavePath(where));
    }, target);
    const win = await app.firstWindow();
    await expect(win.getByRole('navigation', { name: 'Sections' })).toBeVisible({ timeout: 120_000 });
    await win.evaluate((id) => { window.location.hash = `#/runs/${id}`; }, seed.partial);
    const summary = win.locator('[data-coverage-summary]');
    await expect(summary.locator('p')).toHaveCount(3);
    const recorded = await engine<{ coverage: { summary: string } }>(win, `/api/executions/${seed.partial}`);
    expect((await summary.locator('p').allTextContents()).join(' ')).toBe(recorded.coverage.summary);
    await expect(summary.locator('strong').filter({ hasText: '1,824' })).toHaveCount(2);
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'source-summary-paragraphs.png') });

    await win.evaluate(() => { window.location.hash = '#/search/wording'; });
    await win.getByRole('button', { name: 'Scan the Collection' }).click();
    const standard = win.locator('[data-category="standard_statement"]');
    await expect(standard.getByRole('heading', { name: /Standard Statements/ })).toBeVisible({ timeout: 60_000 });
    await expect(standard.locator('[data-pair]')).not.toHaveCount(0);
    const csvPath = path.join(downloads, 'page.csv');
    await downloadTo(csvPath);
    await win.getByRole('button', { name: 'Export Page CSV' }).click();
    await expect.poll(() => fs.existsSync(csvPath)).toBe(true);
    expect(fs.readFileSync(csvPath, 'utf8')).toContain('standard_statement');
    await standard.locator('[data-pair]').first().click();
    await expect(win.locator('.wording-mark').first()).toBeVisible();
    const mdPath = path.join(downloads, 'pair.md');
    await downloadTo(mdPath);
    await win.getByRole('button', { name: 'Export Pair Markdown' }).click();
    await expect.poll(() => fs.existsSync(mdPath)).toBe(true);
    const md = fs.readFileSync(mdPath, 'utf8');
    expect(md).toContain('Views and opinions expressed');
    expect(md).toContain('Limitations');
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'shared-wording-standard-comparison.png') });

    await win.evaluate((id) => { window.location.hash = `#/runs/${id}`; }, seed.partial);
    await win.getByRole('tab', { name: 'Map', exact: true }).click();
    const map = win.locator('.run-map');
    await map.getByRole('button', { name: 'Regions', exact: true }).click();
    const regionList = win.getByRole('dialog', { name: 'Choose Regions' });
    await expect(regionList.getByRole('checkbox').first()).toBeVisible({ timeout: 30_000 });
    await regionList.getByLabel('Sort Regions').selectOption('name');
    const names = await regionList.getByRole('checkbox').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label')!));
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'en-US')));
    const first = regionList.getByRole('checkbox').first();
    const label = await first.getAttribute('aria-label');
    await regionList.getByLabel('Find a Region').fill(label!);
    await first.check();
    await regionList.press('Escape');
    await expect(map.locator('[data-shown]').first()).toContainText('Showing');
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'run-regions-filtered.png') });
  } finally { await app.close(); removeStateDir(state); }
});
