/**
 * Atlas Search and the run screen, in the real app: a Deep Sweep asked from
 * the catalog, followed to its account, exported.
 *
 * Two sources, so each half of the run screen has something to say: arXiv
 * answered by a loopback server in this spec with one authored paper, and
 * Springer Nature, which needs an API key the suite's empty keyring does not
 * have and is therefore recorded as not queried. Every other connection the
 * engine tries, and port 8742, is refused by the startup hook, and the spec
 * fails if anything was.
 *
 * What it checks is what the screen says against what the engine recorded:
 * the coverage sentence and each source's recorded outcome, the live panel's
 * reading of the run's own events (kept in the Progress tab), the run's paper,
 * its export, and the run's line in the log. The journeys J01, J02, J18, J19,
 * J29 and J38 drive the same screens through `journeys/drivers/atlas.ts`; this
 * spec is the part of that which runs on every pull request.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { test, expect, _electron as electron } from '@playwright/test';
import { FRONTEND_ROOT, REPO_ROOT, SCREENSHOT_DIR, launchEnv, registerStateDir } from './fixtures/resmon-app';

const TITLE = 'Authored Atlas search fixture on graph learning';
const FEED = `<feed xmlns="http://www.w3.org/2005/Atom"><entry>
  <id>https://arxiv.org/abs/2609.00003v1</id><title>${TITLE}</title>
  <author><name>Ada Fixture</name></author><published>${new Date().toISOString().slice(0, 10)}T00:00:00Z</published>
  <summary>Authored local fixture, not fetched scholarly content.</summary>
</entry></feed>`;

test('a Deep Sweep from Search, its account, its export, and its line in the log', async () => {
  test.setTimeout(240_000);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-search-'));
  const source = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/atom+xml' });
    res.end(FEED);
  });
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
            raise OSError('atlas-search test guard refuses external/8742 connection')
    return original_connect(self, address)
socket.socket.connect = connect
sys.path.insert(0, ${JSON.stringify(path.join(REPO_ROOT, 'resmon_scripts'))})
from implementation_scripts import api_arxiv
api_arxiv._ARXIV_API_URL = ${JSON.stringify(`http://127.0.0.1:${sourcePort}/api/query`)}
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

    // The catalog states each source's limits before anything is asked.
    await win.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'Search' }).click();
    await win.getByRole('navigation', { name: 'Search' }).getByRole('link', { name: 'Ask the sources' }).click();
    await expect(win.getByRole('heading', { name: 'Ask the sources', level: 1 })).toBeVisible();
    const springer = win.locator('.source[data-source="springer"]');
    await expect(springer).toContainText('needs an API key');
    await expect(win.locator('.source[data-source="arxiv"]')).toContainText('Implicit AND');

    await win.getByRole('button', { name: 'Deep Sweep', exact: true }).click();
    await win.locator('.source[data-source="arxiv"] input').check();
    await springer.locator('input').check();
    const terms = win.getByLabel('Search terms');
    await terms.fill('graph learning');
    await terms.press('Enter');
    await win.getByRole('button', { name: 'Any time', exact: true }).click();
    await expect(win.locator('.ask-facts')).toContainText('Springer Nature has no API key here');
    // bioRxiv with no start date is read from its first month forward, and the
    // form says so before the run rather than after it fails; with a start
    // date set, it does not.
    const biorxiv = win.locator('.source[data-source="biorxiv"] input');
    await biorxiv.check();
    const notice = win.locator('.ask-facts [data-ask="notice"]');
    await expect(notice).toHaveCount(1);
    await expect(notice).toContainText('With no start date, resmon asks bioRxiv for everything since its first preprints');
    await win.getByRole('button', { name: '30 days', exact: true }).click();
    await expect(notice).toHaveCount(0);
    await win.getByRole('button', { name: 'Any time', exact: true }).click();
    await expect(notice).toHaveCount(1);
    await win.locator('.ask-facts').screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-search-notice.png') });
    await biorxiv.uncheck();
    await expect(notice).toHaveCount(0);
    const started = win.waitForResponse((r) => r.url().endsWith('/api/search/sweep') && r.request().method() === 'POST');
    await win.getByRole('button', { name: 'Ask 2 sources' }).click();
    const { execution_id: runId } = await (await started).json() as { execution_id: number };

    // The run's account once it has settled.
    const run = win.locator(`.run[data-run="${runId}"]`);
    await expect(run).toBeVisible();
    await expect(run).not.toHaveAttribute('data-status', 'running', { timeout: 120_000 });
    await expect(run).toHaveAttribute('data-status', 'completed');
    await expect(win.locator('[data-coverage-summary]'))
      .toHaveText('2 selected sources: 1 answered, 1 recorded non-answer (could not answer), 0 unknown.');
    const recorded = win.locator('.recorded .recorded-row');
    await expect(recorded).toHaveCount(2);
    await expect(win.locator('.recorded-row[data-source="arxiv"]')).toHaveAttribute('data-category', 'answered');
    const keyless = win.locator('.recorded-row[data-source="springer"]');
    await expect(keyless).toHaveAttribute('data-category', 'non_answer');
    await expect(keyless.locator('.src-note')).toContainText(/key/i);

    // The run's paper, in its own tab and on the map's caption.
    await expect(win.locator('.paper-row .paper-title')).toHaveText([TITLE]);
    await expect(win.locator('.run-main .sky figcaption')).toContainText(/1 paper/);

    // The live panel's reading of the run's events agrees with the record.
    await win.getByRole('tab', { name: 'Progress' }).click();
    await expect(win.locator('.live-row[data-source="arxiv"]')).toHaveAttribute('data-state', 'answered');
    await expect(win.locator('.live-row[data-source="springer"]')).toHaveAttribute('data-state', 'not_queried');
    await expect(win.locator('.events')).toContainText('The run finished: completed.');
    // Each event's time is the reader's local time, as the heading's is: a
    // clock with AM or PM, never the stored UTC slice.
    await expect(win.locator('.events li .num').first()).toHaveText(/^\d{1,2}:\d{2}:\d{2}\s(AM|PM)$/);

    // The tabs a run's record has.
    expect((await win.getByRole('tab').allInnerTexts()).map((t) => t.trim()))
      .toEqual(['Papers', 'Map', 'Report', 'Search record', 'Log', 'Metadata', 'Progress']);
    await win.getByRole('tab', { name: 'Report' }).click();
    await expect(win.locator('.record-text.is-report')).toContainText(TITLE);

    // The run's own record as files: the real downloads, with only each
    // destination chosen here.
    const downloadTo = (target: string) => app.evaluate(({ BrowserWindow }, where) => {
      BrowserWindow.getAllWindows()[0].webContents.session.once('will-download', (_e, item) => {
        item.setSavePath(where as string);
      });
    }, target);
    const contents = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
    const reportFile = path.join(stateDir, 'atlas-report.md');
    await downloadTo(reportFile);
    await win.locator('[data-record="save-report"]').click();
    await expect.poll(() => contents(reportFile), { timeout: 30_000 }).toContain(TITLE);
    await win.getByRole('tab', { name: 'Search record' }).click();
    // Each source's query as its request carried it, never the words typed
    // under that label; the run's kind and dates in words; no ISO stamp.
    const facts = win.locator('[data-record="search"]');
    await expect(facts.locator('div', { has: win.locator('dt', { hasText: /^Kind$/ }) }).locator('dd')).toHaveText('Deep Sweep');
    const sent = facts.locator('.queries-sent');
    await expect(sent.locator('li[data-source="arxiv"] code'))
      .toHaveText('search_query=all:graph AND all:learning & sortBy=submittedDate & sortOrder=descending');
    await expect(sent.locator('li[data-source="springer"]')).toContainText('Nothing was sent: no API key is configured for it.');
    await expect(facts.locator('div', { has: win.locator('dt', { hasText: /^Dates$/ }) }).locator('dd'))
      .toHaveText('No date limit: each source was asked with no dates.');
    await expect(win.locator('.search-record')).not.toContainText(/\d{4}-\d\d-\d\d|deep_sweep|not recorded/);
    await win.locator('.search-record').screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-run-search-record.png') });
    const recordFile = path.join(stateDir, 'atlas-search-record.md');
    await downloadTo(recordFile);
    await win.locator('[data-record="save-search-record"]').click();
    await expect.poll(() => contents(recordFile), { timeout: 30_000 }).toMatch(/^# Search record/);
    expect(contents(recordFile)).toContain('| Query as sent to arXiv | `search_query=all:graph AND all:learning');

    // The log: local times, sources by name, and Springer Nature's non-answer
    // in its own words rather than as a count. The file keeps UTC and ids.
    await win.getByRole('tab', { name: 'Log' }).click();
    const log = win.locator('.record-text.is-log');
    await expect(log).toContainText('Operation Type: Deep Sweep');
    await expect(log).toContainText('Springer Nature: no API key configured');
    await expect(log).toContainText('arXiv: 1 result');
    // The file paths it names keep the engine's names for the files; nothing else does.
    await expect(log).not.toContainText(/0 results|\d{4}-\d\d-\d\dT|\bspringer\b|: deep_sweep/);
    await expect(log).toContainText(/^\[\d{1,2}:\d{2}:\d{2}\s(AM|PM)\] Querying repository: arXiv$/m);
    await expect(win.locator('[data-record="log-note"]')).toContainText('The log file keeps its times in UTC');
    await win.locator('.run-panel').screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-run-log.png') });

    // Metadata: every field, each under a label a person reads.
    await win.getByRole('tab', { name: 'Metadata' }).click();
    const metadata = win.locator('.run-panel > .record-dl');
    const field = (label: string) => metadata.locator(':scope > div', { has: win.locator(':scope > dt', { hasText: new RegExp(`^${label}$`) }) })
      .locator(':scope > dd');
    await expect(field('Kind')).toHaveText('Deep Sweep');
    await expect(field('Sources')).toHaveText('arXiv, Springer Nature');
    // A search asked by hand belongs to no watch: that is a fact, not a gap in the record.
    await expect(field('Watch id')).toHaveText('none');
    await expect(field('Start time')).toHaveText(/^[A-Z][a-z]+ \d{1,2}, \d{4} at \d{1,2}:\d{2} (AM|PM)$/);
    // The file paths keep the engine's names for the files; nothing else does.
    await expect(metadata).not.toContainText(/Last seen at utc|"repositories"|\['arxiv'/);
    await win.locator('.run-panel').screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-run-metadata.png') });

    // The bundle is built by the engine and saved like the rest: a download,
    // never a path the engine chose. Read with the backend's own interpreter.
    const bundleFile = path.join(stateDir, 'atlas-bundle.zip');
    await downloadTo(bundleFile);
    await win.locator('[data-run="bundle"]').click();
    await expect.poll(() => (fs.existsSync(bundleFile) ? fs.statSync(bundleFile).size : 0), { timeout: 60_000 }).toBeGreaterThan(0);
    const members = JSON.parse(execFileSync(env.RESMON_PYTHON ?? 'python3', ['-c', `
import json, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    assert z.testzip() is None
    print(json.dumps(z.namelist()))
`, bundleFile], { encoding: 'utf8' })) as string[];
    for (const member of ['manifest.json', `execution_${runId}/metadata.json`, `execution_${runId}/search-record.md`]) {
      expect(members, `the bundle has no ${member}`).toContain(member);
    }
    expect(members.some((m) => m.startsWith(`execution_${runId}/`) && m.endsWith('.md') && !m.endsWith('search-record.md')),
      'the bundle carries no report').toBe(true);

    // Export: the real download, with only the destination chosen here.
    const destination = path.join(stateDir, 'atlas-search.bib');
    await app.evaluate(({ BrowserWindow }, target) => {
      BrowserWindow.getAllWindows()[0].webContents.session.once('will-download', (_e, item) => {
        item.setSavePath(target as string);
      });
    }, destination);
    await win.locator('.run-actions').getByRole('button', { name: 'BibTeX', exact: true }).click();
    await expect.poll(() => (fs.existsSync(destination) ? fs.readFileSync(destination, 'utf8') : ''), { timeout: 30_000 })
      .toContain(TITLE);
    expect([...fs.readFileSync(destination, 'utf8').matchAll(/^@\w+\{/gm)]).toHaveLength(1);

    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-run.png') });

    // And its line in the log, back on Search.
    await win.locator('.back').click();
    const line = win.locator(`.run-row[data-run="${runId}"]`);
    await expect(line).toContainText('graph learning');
    await expect(line.locator('.run-status')).toHaveText('1 of 2 sources answered · 1 found, 1 new');
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-search.png') });

    expect(problems).toEqual([]);
  } finally {
    await app.close();
    await new Promise<void>((resolve) => source.close(() => resolve()));
    const blocked = fs.existsSync(path.join(stateDir, 'blocked.jsonl'))
      ? fs.readFileSync(path.join(stateDir, 'blocked.jsonl'), 'utf8') : '';
    expect(blocked).toBe('');
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
