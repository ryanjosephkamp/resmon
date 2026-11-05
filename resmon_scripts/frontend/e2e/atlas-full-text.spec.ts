/**
 * Atlas: Find a paper and Get the PDF, in the real app, with no network.
 *
 * A paper found by its DOI across every source that can look it up, one of
 * them left out by hand; each source's answer read off the page and held to
 * the engine's record; Get the PDF from the find, from a paper's page, and
 * from its card in the Library, each landing a file in the Library folder; a
 * watch with its PDFs switch on, run, getting its new papers' PDFs; and the
 * rules Settings › Library states.
 *
 * **Authored, over real sockets:** the sources are a loopback HTTP server
 * standing in for each source's address (OpenAlex and Crossref hold the paper;
 * every other source answers with nothing), and the PDFs come from a loopback
 * https server whose certificate a test authority made for this run signed.
 * The engine's child is pointed at both by a startup hook that sets the
 * client modules' addresses and the downloader's test-only settings: its CA
 * bundle (verification stays on), the test names that may resolve to
 * loopback, and a resolver for them. The same hook refuses every connection
 * that is not to loopback. Everything downstream (each client's parser, the
 * sweep engine, the downloader's checks, the Library's import) is production
 * code.
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { FRONTEND_ROOT, REPO_ROOT, SCREENSHOT_DIR, atlasEnv, launchEnv, registerStateDir } from './fixtures/resmon-app';
import { findCard } from './fixtures/gallery';
import { writePdf } from './fixtures/pdf';

const DOI = '10.5555/resmon.e2e.find';
const TITLE = 'An authored paper found in the full-text journey';
const WATCH_TITLES = ['A first authored paper a watch finds', 'A second authored paper a watch finds'];

function pdf(line: string): Buffer {
  return writePdf([{ lines: [{ x: 72, y: 700, size: 20, text: line }, { x: 72, y: 660, size: 12, text: 'Authored for the full-text journey; not a paper.' }] }]);
}

/** The engine's child: sources and PDFs on loopback, and nothing else reachable. */
function hook(api: string, pdfPort: number, ca: string, state: string): string {
  return String.raw`
import json, os, socket, sys, ipaddress
from pathlib import Path
state = Path(${JSON.stringify(state)})
original_connect = socket.socket.connect
original_getaddrinfo = socket.getaddrinfo
def checked(address):
    if isinstance(address, tuple):
        host, port = address[:2]
        try: local = ipaddress.ip_address(host).is_loopback
        except ValueError: local = host == 'localhost'
        if not local or port == 8742:
            with (state / 'blocked.jsonl').open('a') as stream:
                stream.write(json.dumps({'host': host, 'port': port}) + "\n")
            raise OSError('full-text journey refuses an external or 8742 connection')
def connect(self, address):
    checked(address)
    return original_connect(self, address)
def getaddrinfo(host, port, *args, **kwargs):
    checked((host, port))
    return original_getaddrinfo(host, port, *args, **kwargs)
socket.socket.connect = connect
socket.getaddrinfo = getaddrinfo
sys.path.insert(0, ${JSON.stringify(path.join(REPO_ROOT, 'resmon_scripts'))})
from implementation_scripts import (api_crossref, api_datacite, api_doaj, api_europepmc, api_hal, api_inspire_hep,
    api_openalex, api_plos, api_semantic_scholar, api_zenodo, api_arxiv, api_eric, fulltext_download)
base = ${JSON.stringify(api)}
api_crossref._CROSSREF_API_URL = base + '/crossref/works'
api_openalex._OPENALEX_API_URL = base + '/openalex/works'
api_datacite._DATACITE_API_URL = base + '/datacite/dois'
api_doaj._DOAJ_API_URL = base + '/doaj/articles'
api_europepmc._EUROPEPMC_API_URL = base + '/europepmc/search'
api_hal._HAL_API_URL = base + '/hal/search/'
api_inspire_hep._INSPIRE_API_URL = base + '/inspire/literature'
api_plos._PLOS_API_URL = base + '/plos/search'
api_semantic_scholar._S2_API_URL = base + '/s2/paper/search'
api_semantic_scholar._S2_MATCH_URL = base + '/s2/paper/search/match'
api_semantic_scholar._S2_PAPER_URL = base + '/s2/paper'
api_zenodo._ZENODO_API_URL = base + '/zenodo/records'
api_arxiv._ARXIV_API_URL = base + '/arxiv/query'
api_eric._ERIC_API_URL = base + '/eric/'
# The downloader's test-only settings: this run's authority, and its one test
# name resolved to loopback. Every other private address is still refused.
fulltext_download._CA_BUNDLE = ${JSON.stringify(ca)}
fulltext_download._LOOPBACK_TEST_HOSTS = frozenset({'pdf.resmon.test'})
def resolve(host, port, *args, **kwargs):
    if host == 'pdf.resmon.test':
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('127.0.0.1', port))]
    return getaddrinfo(host, port, *args, **kwargs)
fulltext_download._RESOLVE = resolve
(state / 'hook.json').write_text(json.dumps({'pid': os.getpid(), 'parent_pid': os.getppid()}))
`;
}

const SEED = String.raw`
import json, os, sys
sys.path.insert(0, sys.argv[1])
from implementation_scripts import library
from implementation_scripts.database import init_db, get_connection
path = os.environ["RESMON_DB_PATH"]
init_db(path)
conn = get_connection(path)
made = library.create_vault(conn, sys.argv[2])
print(json.dumps({"vault": made["vault"]["vault_id"], "root": made["vault"]["path"]}))
`;

const READ = String.raw`
import json, sqlite3, sys
with sqlite3.connect('file:' + sys.argv[1] + '?mode=ro', uri=True) as c:
    c.row_factory = sqlite3.Row
    out = {name: [dict(r) for r in c.execute(sql)] for name, sql in (
        ('downloads', 'SELECT * FROM full_text_downloads ORDER BY id'),
        ('files', 'SELECT * FROM library_files ORDER BY id'),
        ('links', 'SELECT * FROM library_file_documents ORDER BY file_id, document_id'),
        ('documents', 'SELECT id, source_repository, external_id, doi, title FROM documents ORDER BY id'),
        ('find', 'SELECT * FROM execution_find_results ORDER BY execution_id, position'),
        ('sources', 'SELECT execution_id, source, status, result_count, zero_reason FROM execution_sources ORDER BY rowid'),
        ('runs', 'SELECT id, execution_type, status FROM executions ORDER BY id'),
        ('same_paper', "SELECT * FROM document_links WHERE kind = 'same_paper'"),
    )}
print(json.dumps(out))
`;

interface Stored {
  downloads: Record<string, unknown>[]; files: Record<string, unknown>[]; links: Record<string, unknown>[];
  documents: { id: number; source_repository: string; external_id: string; doi: string | null; title: string }[];
  find: Record<string, unknown>[]; sources: Record<string, unknown>[]; runs: { id: number; execution_type: string; status: string }[];
  same_paper: Record<string, unknown>[];
}

function work(id: string, title: string, doi: string | null, pdfUrl: string): Record<string, unknown> {
  return {
    id: `https://openalex.org/${id}`, doi: doi ? `https://doi.org/${doi}` : null, display_name: title,
    publication_date: '2026-10-01', authorships: [{ author: { display_name: 'Ada Fixture' } }],
    primary_location: { landing_page_url: `https://journal.resmon.test/${id}` },
    locations: [{ is_oa: true, pdf_url: pdfUrl, landing_page_url: `https://journal.resmon.test/${id}`, license: 'cc-by', version: 'publishedVersion' }],
  };
}

async function shoot(win: Page, name: string): Promise<void> {
  await win.screenshot({ path: path.join(SCREENSHOT_DIR, name) });
}

test('Find a paper across the sources, Get the PDF three ways, and a watch that gets its new papers’ PDFs', async () => {
  test.setTimeout(420_000);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-full-text-'));
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-full-text-library-')));
  const tls = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-full-text-tls-'));
  fs.mkdirSync(path.join(tls, 'serve'));
  fs.writeFileSync(path.join(tls, 'serve', 'paper.pdf'), pdf('The found paper'));
  fs.writeFileSync(path.join(tls, 'serve', 'second.pdf'), pdf('A first paper a watch finds'));
  fs.writeFileSync(path.join(tls, 'serve', 'third.pdf'), pdf('A second paper a watch finds'));
  const env = atlasEnv({ ...launchEnv(stateDir, true) });
  const python = env.RESMON_PYTHON ?? 'python3';

  // The PDFs' https server, with its own test authority.
  const pdfServer: ChildProcessWithoutNullStreams = spawn(python, [
    path.join(REPO_ROOT, 'resmon_scripts', 'verification_scripts', 'tls_loopback.py'), tls], { env });
  const ready = await new Promise<{ port: number; ca: string }>((resolve, reject) => {
    let out = '';
    pdfServer.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      const line = out.split('\n').find((l) => l.trim().startsWith('{'));
      if (line) resolve(JSON.parse(line));
    });
    pdfServer.on('exit', (code) => reject(new Error(`the PDF server exited with ${code}`)));
    setTimeout(() => reject(new Error('the PDF server did not start')), 30_000);
  });
  const pdfAt = (name: string) => `https://pdf.resmon.test:${ready.port}/${name}`;

  // The sources' stand-in. OpenAlex and Crossref hold the paper; OpenAlex's
  // search answers a watch with two new papers; every other address answers
  // with an empty JSON object, which each client reads as no records.
  const asked: string[] = [];
  const api = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const where = decodeURIComponent(url.pathname);
    asked.push(where);
    let body: unknown = {};
    if (where === `/openalex/works/doi:${DOI}`) body = work('W9100000001', TITLE, DOI, pdfAt('paper.pdf'));
    else if (where === '/openalex/works') {
      body = { results: [work('W9100000002', WATCH_TITLES[0]!, null, pdfAt('second.pdf')),
        work('W9100000003', WATCH_TITLES[1]!, null, pdfAt('third.pdf'))] };
    } else if (where === `/crossref/works/${DOI}`) {
      body = { message: { DOI, title: [TITLE], URL: `https://doi.org/${DOI}`, author: [{ given: 'Ada', family: 'Fixture' }],
        issued: { 'date-parts': [[2026, 10, 1]] } } };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  const apiPort = (api.address() as net.AddressInfo).port;
  expect(apiPort).not.toBe(8742);

  const hookDir = path.join(stateDir, 'python-hook');
  fs.mkdirSync(hookDir);
  fs.writeFileSync(path.join(hookDir, 'sitecustomize.py'), hook(`http://127.0.0.1:${apiPort}`, ready.port, ready.ca, stateDir));
  env.PYTHONPATH = [hookDir, env.PYTHONPATH].filter(Boolean).join(path.delimiter);
  env.PYTHONDONTWRITEBYTECODE = '1';
  env.NO_PROXY = env.no_proxy = '127.0.0.1,localhost';
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[key];

  const seeded = spawnSync(python, ['-c', SEED, path.join(REPO_ROOT, 'resmon_scripts'), parent], { env, encoding: 'utf8' });
  expect(seeded.status, seeded.stderr).toBe(0);
  const { root } = JSON.parse(seeded.stdout.trim().split('\n').pop() ?? '{}') as { vault: string; root: string };
  const stored = (): Stored => JSON.parse(execPython(python, READ, env.RESMON_DB_PATH!, env));

  const app = await electron.launch({
    args: ['.', `--user-data-dir=${path.join(stateDir, 'electron-user-data')}`],
    cwd: FRONTEND_ROOT, env, colorScheme: null, timeout: 180_000,
  });
  registerStateDir(stateDir);
  try {
    const win = await app.firstWindow({ timeout: 180_000 });
    const problems: string[] = [];
    win.on('pageerror', (e) => problems.push(e.message));
    await win.getByRole('navigation', { name: 'Sections' }).waitFor({ state: 'visible', timeout: 60_000 });
    const hooked = JSON.parse(fs.readFileSync(path.join(stateDir, 'hook.json'), 'utf8')) as { parent_pid: number };
    expect(hooked.parent_pid).toBe(app.process().pid);
    const port = fs.readFileSync(env.RESMON_PORT_FILE!, 'utf8').trim();
    expect(port).not.toBe('8742');
    const engineUrl = (p: string) => `http://127.0.0.1:${port}${p}`;
    const call = async (method: string, p: string, body?: unknown) => {
      const response = await e2eFetch(engineUrl(p), {
        method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
      });
      expect(response.ok, `${method} ${p}: ${response.status}`).toBe(true);
      return response.json();
    };

    // — Find a paper: what it reads as, and who is asked ------------------------------
    await win.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'Search' }).click();
    await win.getByRole('navigation', { name: 'Search' }).getByRole('link', { name: 'Find a paper' }).click();
    await expect(win.getByRole('heading', { name: 'Find a paper', level: 1 })).toBeVisible();
    await win.locator('[data-find="query"]').fill(`https://doi.org/${DOI}`);
    const reads = win.locator('[data-find="reads"]');
    await expect(reads).toHaveAttribute('data-kind', 'doi', { timeout: 30_000 });
    await expect(reads).toContainText(`Reads as a DOI ${DOI}.`);
    const picks = win.getByRole('group', { name: 'The sources to ask' });
    await expect(picks.locator('[data-source="openalex"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(picks.locator('[data-source="arxiv"]')).toHaveCount(0);
    // Any or all: Zenodo is left out by hand.
    await picks.locator('[data-source="zenodo"]').click();
    await expect(picks.locator('[data-source="zenodo"]')).toHaveAttribute('aria-pressed', 'false');
    await win.locator('details.find-not-asked summary').click();
    await expect(win.locator('details.find-not-asked')).toContainText('arXiv can be asked by arXiv id, title, not by DOI.');
    await shoot(win, 'atlas-find-plan.png');

    const started = Date.now();
    await win.locator('[data-find="go"]').click();
    const result = win.locator('[data-find="result"]');
    await expect(result).toBeVisible({ timeout: 120_000 });
    const asking = Date.now() - started;
    await expect(result).toHaveAttribute('data-found', '2');
    const row = (slug: string) => result.locator(`.find-source[data-source="${slug}"]`);
    await expect(row('openalex')).toHaveAttribute('data-outcome', 'found');
    await expect(row('openalex')).toContainText('Found by its DOI');
    await expect(row('openalex')).toContainText(`Open copy at pdf.resmon.test, CC BY`);
    await expect(row('crossref')).toHaveAttribute('data-outcome', 'found');
    await expect(row('europepmc')).toHaveAttribute('data-outcome', 'not_found');
    await expect(row('europepmc')).toContainText('Not found: it answered with nothing');
    await expect(row('arxiv')).toHaveAttribute('data-outcome', 'not_asked');
    await expect(row('zenodo')).toHaveAttribute('data-outcome', 'not_asked');
    await expect(row('zenodo')).toContainText('Left out of this find.');
    await expect(win.locator('[data-find="paper"]')).toContainText(TITLE);
    await win.locator('details.find-not-asked summary').click();
    await result.scrollIntoViewIfNeeded();
    await shoot(win, 'atlas-find-result.png');

    // Held to the engine's record: a find_paper run, every asked source's answer, the two copies linked.
    const runId = Number(new URL(win.url()).hash.match(/run=(\d+)/)?.[1]);
    let record = stored();
    const run = record.runs.find((r) => r.execution_type === 'find_paper');
    expect(run?.status).toBe('completed');
    const findRows = record.find.filter((r) => r.execution_id === run!.id);
    expect(findRows.filter((r) => r.outcome === 'found').map((r) => r.source).sort()).toEqual(['crossref', 'openalex']);
    expect(findRows.find((r) => r.source === 'zenodo')).toMatchObject({ outcome: 'not_asked', detail: 'Left out of this find.' });
    expect(record.sources.filter((s) => s.execution_id === run!.id).map((s) => s.source)).toContain('openalex');
    expect(record.same_paper).toHaveLength(1);
    const found = await call('GET', `/api/executions/${run!.id}/find`) as { counts: Record<string, number> };
    expect(found.counts.found).toBe(2);
    expect(runId).toBe(run!.id);

    // — Get the PDF, from the find -----------------------------------------------------
    const getting = Date.now();
    await win.locator('[data-find="paper"] [data-fulltext="get"]').click();
    await expect(win.locator('[data-find="paper"] [data-fulltext="read"]')).toBeVisible({ timeout: 60_000 });
    const gotIn = Date.now() - getting;
    record = stored();
    expect(record.downloads).toHaveLength(1);
    const first = record.downloads[0]!;
    expect(first).toMatchObject({ state: 'stored', license: 'cc-by', reported_by: 'openalex', final_url: pdfAt('paper.pdf') });
    const file = record.files.find((f) => f.file_id === first.file_id)!;
    expect(fs.readFileSync(path.join(root, String(file.relative_path)))).toEqual(fs.readFileSync(path.join(tls, 'serve', 'paper.pdf')));

    // — Get the PDF, from a paper's page: the OpenAlex copy, not yet linked to a file ----
    const openalexDoc = record.documents.find((d) => d.source_repository === 'openalex' && d.doi === DOI)!;
    await row('openalex').getByRole('link', { name: 'OpenAlex' }).click();
    await expect(win.getByRole('heading', { name: TITLE, level: 1 })).toBeVisible();
    const pageGet = win.locator('.paper-main [data-fulltext="get"]');
    await expect(pageGet).toBeVisible({ timeout: 30_000 });
    await expect(win.locator('.paper-main .fulltext-line')).toHaveText('Open copy at pdf.resmon.test, CC BY.');
    await shoot(win, 'atlas-paper-get-the-pdf.png');
    // Saved to read first, so its card in the Library is the next way in.
    await win.getByRole('button', { name: 'Save to read' }).click();
    await expect(win.locator('.paper-actions')).toHaveAttribute('data-queue', 'to_read');

    // — Get the PDF, from its card in the Library ---------------------------------------
    await win.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'Library' }).click();
    const card = await findCard(win, TITLE);
    const cardGet = card.locator('[data-fulltext="get"]');
    await expect(cardGet).toBeVisible({ timeout: 30_000 });
    await expect(cardGet).toHaveAttribute('title', `Get the PDF from pdf.resmon.test (CC BY)`);
    await shoot(win, 'atlas-library-card-get.png');
    await cardGet.click();
    // Afterward it is a PDF card with its cover, drawn from the file's first page.
    await expect(card.locator('[data-cover="pdf"]')).toBeVisible({ timeout: 60_000 });
    await expect(card.locator('[data-cover="pdf"]')).toHaveAttribute('data-drawn', 'true', { timeout: 60_000 });
    await expect(card.getByRole('link', { name: 'Read' })).toHaveAttribute('href', /\/library\/files\//);
    await shoot(win, 'atlas-library-card-pdf.png');
    record = stored();
    // The same bytes again: the Library keeps one file and links the second copy to it.
    expect(record.files).toHaveLength(1);
    expect(record.links.map((l) => l.document_id).sort()).toEqual(
      record.documents.filter((d) => d.doi === DOI).map((d) => d.id).sort());
    expect(record.downloads.map((d) => d.state)).toEqual(['stored', 'stored']);
    expect(record.downloads[1]!.document_id).toBe(openalexDoc.id);

    // — A watch with its PDFs switch on ---------------------------------------------------
    const made = await call('POST', '/api/routines', {
      name: 'Full-text journey watch', schedule_cron: '0 7 * * 1',
      parameters: { repositories: ['openalex'], keywords: ['fixture'], query: 'fixture', max_results: 10 },
      is_active: false, download_full_text: true,
    }) as { id: number };
    await win.evaluate((to) => { window.location.hash = to; }, `#/watches/${made.id}/edit`);
    const pdfSwitch = win.locator('[data-switch="download_full_text"]');
    await expect(pdfSwitch).toHaveAttribute('aria-checked', 'true', { timeout: 30_000 });
    await expect(win.locator('[data-editor="pdfs"]')).toContainText('At most 20 a run and 100 in any 24 hours');
    await pdfSwitch.scrollIntoViewIfNeeded();
    await shoot(win, 'atlas-watch-pdfs-switch.png');
    const fired = await call('POST', `/api/routines/${made.id}/run`) as { execution_id: number };
    await expect.poll(() => stored().downloads.filter((d) => d.execution_id === fired.execution_id && d.state === 'stored').length,
      { timeout: 120_000 }).toBe(2);
    await win.evaluate((to) => { window.location.hash = to; }, `#/runs/${fired.execution_id}`);
    const pdfs = win.locator('[data-run="pdfs"]');
    await expect(pdfs).toContainText('2 got into the Library', { timeout: 30_000 });
    for (const title of WATCH_TITLES) await expect(pdfs).toContainText(title);
    await pdfs.scrollIntoViewIfNeeded();
    await shoot(win, 'atlas-run-pdfs.png');
    record = stored();
    expect(record.files).toHaveLength(3);
    expect(record.downloads.filter((d) => d.execution_id === fired.execution_id).every((d) => d.requested_by === 'watch')).toBe(true);

    // — The rules, in Settings › Library -----------------------------------------------
    await win.evaluate(() => { window.location.hash = '#/settings/library'; });
    const rules = win.locator('[data-library="downloads"]');
    await expect(rules).toContainText('at most 20 PDFs for one watch run, and 100 PDFs in any 24 hours', { timeout: 30_000 });
    await expect(rules).toContainText('Never from NASA ADS, Springer, CORE');
    await rules.scrollIntoViewIfNeeded();
    await shoot(win, 'atlas-settings-downloads.png');

    // — Narrow: the find again, at a phone-like width -----------------------------------
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(720, 900));
    await win.evaluate((to) => { window.location.hash = to; }, `#/search/find?run=${run!.id}`);
    await expect(win.locator('[data-find="result"]')).toBeVisible({ timeout: 30_000 });
    await shoot(win, 'atlas-find-result-narrow.png');
    // And by day: the same page in the light theme.
    await call('PUT', '/api/appearance', { theme: 'light', accent: null });
    await win.reload();
    await expect(win.locator('[data-find="result"]')).toBeVisible({ timeout: 60_000 });
    await win.locator('[data-find="result"]').scrollIntoViewIfNeeded();
    await shoot(win, 'atlas-find-result-light.png');

    expect(problems).toEqual([]);
    const blocked = fs.existsSync(path.join(stateDir, 'blocked.jsonl')) ? fs.readFileSync(path.join(stateDir, 'blocked.jsonl'), 'utf8') : '';
    expect(blocked).toBe('');
    console.log('MEASURE full-text journey', JSON.stringify({ find_ms: asking, get_the_pdf_ms: gotIn, asked: asked.length }));
  } finally {
    await app.close().catch(() => undefined);
    pdfServer.stdin.end();
    await new Promise((resolve) => pdfServer.once('exit', resolve));
    await new Promise<void>((resolve) => api.close(() => resolve()));
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(parent, { recursive: true, force: true });
    fs.rmSync(tls, { recursive: true, force: true });
  }
});

function execPython(python: string, script: string, db: string, env: Record<string, string>): string {
  const ran = spawnSync(python, ['-c', script, db], { env, encoding: 'utf8' });
  if (ran.status !== 0) throw new Error(ran.stderr);
  return ran.stdout;
}
