/**
 * Atlas: the check for retractions and updates, in the real app, from the
 * Watchdog, against Crossref and arXiv answered on loopback by this spec.
 *
 * A seeded collection of four papers: two with DOIs (one Crossref says was
 * retracted, one corrected), an arXiv preprint held at version 1 when arXiv
 * serves version 2, and one paper with no identifier at all. One person is
 * matched to the two with DOIs. The check is run three times, as a person
 * would: first with both services down, and the screen must say which did not
 * answer and for how many papers, never that nothing was found; then with
 * Crossref's answer held while Stop is pressed, so its answer is kept and the
 * arXiv request after it is never made; then Check everything, for the paper
 * left. After each, the screen is held to what the engine recorded in SQLite.
 * Then the retraction is read where a person meets it: on the paper's row in
 * the collection and in Today, on its own page, and on the person's page.
 *
 * What it replaces is the input, the services' answers, and nothing else: the
 * requests are real HTTP over real sockets, made by the shipped providers
 * through `safe_request`, and every record and sentence downstream is the
 * app's own. Every other connection, and port 8742, is refused by the startup
 * hook, and the spec fails if anything was.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { FRONTEND_ROOT, REPO_ROOT, SCREENSHOT_DIR, launchEnv, registerStateDir } from './fixtures/resmon-app';

const RETRACTED = '10.5555/lifecycle-retracted-fixture';
const CORRECTED = '10.5555/lifecycle-corrected-fixture';
const RETRACTION_NOTICE = '10.5555/lifecycle-retraction-notice';
const CORRECTION_NOTICE = '10.5555/lifecycle-correction-notice';
const PREPRINT = '2609.51001';

/** Crossref works as the shipped parser reads them; every DOI here is invented for the suite. */
const WORKS: Record<string, unknown> = {
  [RETRACTED]: { DOI: RETRACTED, 'updated-by': [{
    DOI: RETRACTION_NOTICE, type: 'retraction', label: 'Retraction', source: 'retraction-watch',
    updated: { 'date-parts': [[2026, 9, 15]] },
  }] },
  [CORRECTED]: { DOI: CORRECTED, 'updated-by': [{
    DOI: CORRECTION_NOTICE, type: 'correction', label: 'Correction', source: 'publisher',
    updated: { 'date-parts': [[2026, 8, 3]] },
  }] },
};

const SEED = String.raw`
import json, os, sys
sys.path.insert(0, sys.argv[1])
from implementation_scripts.database import init_db, get_connection, insert_document
from implementation_scripts import watch_profiles as wp
path = os.environ["RESMON_DB_PATH"]
init_db(path)
conn = get_connection(path)
docs = [insert_document(conn, {
    "source_repository": source, "external_id": external, "title": title, "doi": doi,
    "authors": "Ada Fixture, Ben Other", "publication_date": "2026-06-01",
    "abstract": "An authored abstract for the suite, not a published one.", "metadata_hash": f"life-{n}"})
    for n, (source, external, doi, title) in enumerate((
        ("crossref", "life-a", "${RETRACTED}", "Authored fixture: a result its journal later withdrew"),
        ("crossref", "life-b", "${CORRECTED}", "Authored fixture: a result its publisher later corrected"),
        ("arxiv", "${PREPRINT}v1", None, "Authored fixture: a preprint posted again since"),
        ("dblp", "life-d", None, "Authored fixture with no identifier to ask about"),
    ))]
person = wp.create_profile(conn, {"kind": "person", "display_name": "Ada Fixture",
    "names": [{"value": "Ada Fixture"}], "affiliations": ["University of Somewhere"]})
for doc in docs[:2]:
    conn.execute("INSERT INTO watch_profile_matches (document_id, profile_id, basis, matched_author, evidence) "
                 "VALUES (?, ?, 'name+affiliation', 'Ada Fixture', 'seeded for the suite')", (doc, person["id"]))
conn.commit()
print(json.dumps({"docs": docs, "person": person["id"]}))
`;

/** What the engine recorded, read straight from SQLite. */
const STORED = String.raw`
import json, os, sqlite3
c = sqlite3.connect("file:" + os.environ["RESMON_DB_PATH"] + "?mode=ro", uri=True)
c.row_factory = sqlite3.Row
print(json.dumps({
    "checks": {str(r["document_id"]): r["status"] for r in c.execute("SELECT document_id, status FROM document_lifecycle_checks")},
    "events": [dict(r) for r in c.execute(
        "SELECT document_id, kind, severity, label, notice_url, notice_date, provider, provider_source "
        "FROM document_lifecycle ORDER BY document_id, kind")],
}))
`;

type Reply = 'answer' | 'dead' | 'held';
interface Stored { checks: Record<string, string>; events: Record<string, string | number | null>[] }
interface Unanswered { service: string; name: string; papers: number; reason: string | null }
interface Report {
  run: { running: boolean; last: null | { stopped: boolean; not_asked: number; unanswered: Unanswered[];
    outcomes: { ok: number; no_identifier: number; error: number } } };
}

async function api<T>(win: Page, route: string): Promise<T> {
  return win.evaluate(async (r) => {
    const port = (window as unknown as { resmonAPI: { getBackendPort(): string } }).resmonAPI.getBackendPort();
    return (await e2eFetch(`http://127.0.0.1:${port}${r}`)).json() as Promise<unknown>;
  }, route) as Promise<T>;
}

test('the check for retractions and updates: run, stopped, and read where the papers are', async () => {
  test.setTimeout(300_000);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-lifecycle-'));

  // — the services, answered on loopback ------------------------------------------
  const replies: Record<string, Reply> = { crossref: 'dead', arxiv: 'dead' };
  const requests: { service: string; url: string }[] = [];
  let release: () => void = () => {};
  let gate: Promise<void> = Promise.resolve();
  const sockets = new Set<net.Socket>();
  const source = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const service = url.pathname.startsWith('/crossref/') ? 'crossref' : url.pathname.startsWith('/arxiv/') ? 'arxiv' : 'other';
    requests.push({ service, url: req.url ?? '' });
    const mode = replies[service];
    const respond = () => {
      if (service === 'other') {
        res.writeHead(404);
        res.end('no such authored service');
        return;
      }
      if (mode === 'dead') {
        // The connection ends without an HTTP response, as a service that is down does.
        req.socket.destroy();
        return;
      }
      if (service === 'crossref') {
        const asked = (url.searchParams.get('filter') ?? '').split(',').map((f) => f.replace(/^doi:/, '').toLowerCase());
        const items = asked.flatMap((doi) => (WORKS[doi] ? [WORKS[doi]] : []));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', message: { items } }));
        return;
      }
      const entries = (url.searchParams.get('id_list') ?? '').split(',').filter(Boolean)
        .map((id) => `<entry><id>http://arxiv.org/abs/${id}v2</id><title>Authored fixture</title></entry>`).join('');
      res.writeHead(200, { 'Content-Type': 'application/atom+xml' });
      res.end(`<feed xmlns="http://www.w3.org/2005/Atom">${entries}</feed>`);
    };
    if (mode === 'held') void gate.then(respond);
    else respond();
  });
  source.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>((resolve) => source.listen(0, '127.0.0.1', resolve));
  const port = (source.address() as net.AddressInfo).port;
  expect(port).not.toBe(8742);
  const base = `http://127.0.0.1:${port}`;

  const env: Record<string, string> = { ...launchEnv(stateDir, true), RESMON_UI: 'atlas' };
  const seeded = spawnSync(env.RESMON_PYTHON ?? 'python3', ['-c', SEED, path.join(FRONTEND_ROOT, '..')], { env, encoding: 'utf8' });
  expect(seeded.status, seeded.stderr).toBe(0);
  const { docs, person } = JSON.parse(seeded.stdout.trim().split('\n').pop() ?? '{}') as { docs: number[]; person: number };
  const [retracted, corrected, preprint, unaskable] = docs as [number, number, number, number];
  const stored = (): Stored => {
    const read = spawnSync(env.RESMON_PYTHON ?? 'python3', ['-c', STORED], { env, encoding: 'utf8' });
    expect(read.status, read.stderr).toBe(0);
    return JSON.parse(read.stdout.trim()) as Stored;
  };

  // The hook refuses every connection that is not loopback, and 8742, then
  // points the shipped lifecycle providers at the server above.
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
            raise OSError('atlas-lifecycle test guard refuses external/8742 connection')
    return original_connect(self, address)
socket.socket.connect = connect
sys.path.insert(0, ${JSON.stringify(path.join(REPO_ROOT, 'resmon_scripts'))})
from implementation_scripts import lifecycle
lifecycle._CROSSREF_URL = ${JSON.stringify(`${base}/crossref/works`)}
lifecycle._BIORXIV_URL = ${JSON.stringify(`${base}/biorxiv/details`)}
lifecycle._ARXIV_URL = ${JSON.stringify(`${base}/arxiv/api/query`)}
`);
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
    const sections = win.getByRole('navigation', { name: 'Sections' });
    await sections.waitFor({ timeout: 120_000 });
    await sections.getByRole('link', { name: 'Health' }).click();
    await win.getByRole('navigation', { name: 'Health' }).getByRole('link', { name: /Watchdog/ }).click();

    const panel = win.locator('[data-health="lifecycle"]');
    const coverage = panel.locator('[data-lifecycle="coverage"] li');
    const lastRun = panel.locator('[data-lifecycle="last-run"]');
    await expect(coverage.first()).toHaveText('None of your 4 papers has been checked yet.', { timeout: 60_000 });
    await expect(panel.locator('[data-lifecycle="quiet"]')).toContainText('says nothing about your papers');
    // The help says what is asked of whom, in the engine's numbers.
    await panel.locator('details.place-help summary').click();
    await expect(panel.locator('.place-help-body')).toContainText('40 DOIs to a request');

    // — 1: both services down --------------------------------------------------------
    await panel.getByRole('button', { name: 'Check for retractions and updates' }).click();
    await expect(lastRun).toBeVisible({ timeout: 60_000 });
    const first = await api<Report>(win, '/api/lifecycle');
    expect(first.run.last?.outcomes).toEqual({ ok: 0, no_identifier: 1, error: 0 });
    const down = first.run.last?.unanswered ?? [];
    expect(down.map((u) => [u.service, u.papers])).toEqual([['arxiv', 1], ['crossref', 2]]);
    await expect(lastRun).toHaveAttribute('data-unanswered', '2');
    await expect(lastRun.locator('.life-run-head')).toHaveText(/^The check .+ could not check a single paper\.$/);
    for (const service of down) {
      await expect(lastRun.locator(`[data-line="unanswered:${service.service}"]`)).toHaveText(
        `${service.name} did not answer for ${service.papers} ${service.papers === 1 ? 'paper' : 'papers'} (${service.reason}). `
        + `${service.papers === 1 ? 'It stays' : 'They stay'} unchecked, not cleared, and ${service.papers === 1 ? 'is' : 'are'} `
        + 'asked about again on the next check.');
    }
    await expect(lastRun.locator('[data-line="no-identifier"]')).toContainText('nothing to ask about it');
    await expect(coverage.first()).toHaveText('None of your 4 papers has been checked yet.');
    await expect(panel.locator('[data-lifecycle="quiet"]')).toContainText('says nothing about your papers');
    // Recorded: only the paper with nothing to ask about, as such; the rest left for the next check.
    expect(stored()).toEqual({ checks: { [String(unaskable)]: 'no_identifier' }, events: [] });
    expect(requests.map((r) => r.service).sort()).toEqual(['arxiv', 'crossref']);
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await lastRun.scrollIntoViewIfNeeded();
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-lifecycle-unanswered.png') });

    // — 2: Crossref answers, held, while Stop is pressed --------------------------------
    replies.crossref = 'held';
    replies.arxiv = 'answer';
    gate = new Promise<void>((resolve) => { release = resolve; });
    const before = requests.length;
    await panel.getByRole('button', { name: 'Check for retractions and updates' }).click();
    await expect.poll(() => requests.length, { timeout: 30_000 }).toBe(before + 1);
    expect(requests[before]?.service).toBe('crossref');
    await expect(panel.locator('[data-lifecycle="controls"]')).toHaveAttribute('data-running', 'true');
    await panel.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(panel.locator('[data-lifecycle="running"]'))
      .toHaveText('Stopping: the request already out is answered first, and nothing more is asked.');
    release();
    await expect(lastRun).toHaveAttribute('data-stopped', 'true', { timeout: 60_000 });
    await expect(lastRun.locator('.life-run-head')).toHaveText(/^Stopped .+, with 2 papers checked\.$/);
    await expect(lastRun.locator('[data-line="not-asked"]'))
      .toHaveText('1 paper it had selected was not asked about, and stays unchecked.');
    // The arXiv request after Crossref's was never made.
    expect(requests.slice(before).map((r) => r.service)).toEqual(['crossref']);
    const second = await api<Report>(win, '/api/lifecycle');
    expect(second.run.last).toMatchObject({ stopped: true, not_asked: 1, outcomes: { ok: 2, no_identifier: 0, error: 0 } });
    const afterStop = stored();
    expect(afterStop.checks).toEqual({ [String(retracted)]: 'ok', [String(corrected)]: 'ok', [String(unaskable)]: 'no_identifier' });
    expect(afterStop.events).toEqual([
      { document_id: retracted, kind: 'retraction', severity: 'critical', label: 'Retraction',
        notice_url: `https://doi.org/${RETRACTION_NOTICE}`, notice_date: '2026-09-15', provider: 'crossref',
        provider_source: 'retraction-watch' },
      { document_id: corrected, kind: 'correction', severity: 'informational', label: 'Correction',
        notice_url: `https://doi.org/${CORRECTION_NOTICE}`, notice_date: '2026-08-03', provider: 'crossref',
        provider_source: 'publisher' },
    ]);
    // The findings, drawn from that record.
    await expect(panel.locator('[data-lifecycle="counts"]'))
      .toHaveText('2 notices: 1 withdrawn from the record, 1 changed since you found it');
    await expect(panel.locator('.life-papers > li')).toHaveCount(2);
    const listed = panel.locator(`.life-papers > li[data-document="${retracted}"]`);
    await expect(listed.locator('.life-mark[data-severity="critical"] .life-notice')).toHaveText('Retraction');
    await expect(panel.locator(`.life-papers > li[data-document="${corrected}"] .life-mark[data-severity="informational"] .life-notice`))
      .toHaveText('Correction');
    await expect(coverage.nth(0)).toHaveText('2 of your 4 papers have been checked.');
    await expect(coverage.nth(1)).toHaveText('1 has not been asked about yet.');
    await lastRun.scrollIntoViewIfNeeded();
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-lifecycle-stopped.png') });

    // — 3: Check everything, for the paper left -------------------------------------------
    const beforeAll = requests.length;
    await panel.getByRole('button', { name: 'Check everything (1 left)' }).click();
    await expect(lastRun).toHaveAttribute('data-stopped', 'false', { timeout: 60_000 });
    await expect(lastRun.locator('.life-run-head')).toHaveText(/^Checked 1 paper .+\.$/, { timeout: 60_000 });
    expect(requests.slice(beforeAll).map((r) => r.service)).toEqual(['arxiv']);
    expect(requests.slice(beforeAll)[0]?.url).toContain(`id_list=${PREPRINT}`);
    const covered = stored();
    expect(covered.checks[String(preprint)]).toBe('ok');
    expect(covered.events.find((e) => e.document_id === preprint)).toMatchObject({
      kind: 'new_version', severity: 'informational', label: 'Version 2 posted', provider: 'arxiv',
      notice_url: `https://arxiv.org/abs/${PREPRINT}v2`,
    });
    await expect(coverage.nth(0)).toHaveText('3 of your 4 papers have been checked.');
    await expect(panel.getByRole('button', { name: /^Check everything/ })).toHaveCount(0);

    // — the marks where the papers are ----------------------------------------------------
    await sections.getByRole('link', { name: 'Search' }).click();
    const row = (id: number) => win.locator(`.result[data-document="${id}"]`);
    const withdrawn = row(retracted).locator('.life-mark[data-severity="critical"]');
    await expect(withdrawn.locator('.life-severity')).toHaveText('Withdrawn from the record', { timeout: 30_000 });
    await expect(withdrawn.locator('.life-notice')).toHaveText('Retraction');
    await expect(withdrawn.locator('.life-notice')).toHaveAttribute('href', `https://doi.org/${RETRACTION_NOTICE}`);
    await expect(row(corrected).locator('.life-mark .life-notice')).toHaveText('Correction');
    await expect(row(preprint).locator('.life-mark .life-notice')).toHaveText('Version 2 posted');
    await expect(row(unaskable).locator('.result-title')).toBeVisible();
    await expect(row(unaskable).locator('.life-mark')).toHaveCount(0);
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-lifecycle-collection.png') });

    await row(retracted).locator('.result-title').click();
    const own = win.locator('[data-lifecycle="paper"]');
    await expect(own).toHaveAttribute('data-state', 'events', { timeout: 30_000 });
    await expect(own.locator('.life-mark[data-severity="critical"]'))
      .toContainText('Withdrawn from the record');
    await expect(own.locator('.life-day')).toHaveText('September 15, 2026');
    await expect(own.locator('.life-from')).toHaveText('via Retraction Watch');
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-lifecycle-paper.png') });
    await win.evaluate((id) => { window.location.hash = `#/papers/${id}`; }, unaskable);
    await expect(own).toHaveAttribute('data-state', 'no_identifier', { timeout: 30_000 });
    await expect(own.locator('.life-quiet')).toContainText('That is not a clean result.');

    // Today lists the papers collected this week, and marks them the same way.
    await sections.getByRole('link', { name: 'Today' }).click();
    await expect(win.locator(`.entry[data-paper="${retracted}"] .life-mark[data-severity="critical"] .life-notice`))
      .toHaveText('Retraction', { timeout: 30_000 });

    // — the person's page ------------------------------------------------------------------
    await sections.getByRole('link', { name: 'Watches' }).click();
    await win.getByRole('navigation', { name: 'Watches' }).getByRole('link', { name: 'People' }).click();
    await win.locator(`.person[data-profile="${person}"] .watch-name`).click();
    const theirs = win.locator('[data-people="lifecycle"]');
    const served = await api<{ coverage_note: string; findings: unknown[] }>(win, `/api/profiles/${person}/lifecycle`);
    expect(served.findings).toHaveLength(2);
    await expect(theirs.locator('[data-people="lifecycle-coverage"]')).toHaveText(served.coverage_note, { timeout: 30_000 });
    const finding = theirs.locator(`.life-finding[data-document="${retracted}"]`);
    await expect(finding).toHaveAttribute('data-severity', 'critical');
    await expect(finding.locator('.life-notice')).toHaveText('Retraction');
    await expect(finding.locator('.basis-chip')).toHaveText('name + affiliation');
    await expect(theirs.locator(`.life-finding[data-document="${corrected}"] .life-notice`)).toHaveText('Correction');
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-lifecycle-person.png') });

    expect(requests.filter((r) => r.service === 'other')).toEqual([]);
    expect(problems).toEqual([]);
  } finally {
    release();
    await app.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => source.close(() => resolve()));
    const blocked = fs.existsSync(path.join(stateDir, 'blocked.jsonl'))
      ? fs.readFileSync(path.join(stateDir, 'blocked.jsonl'), 'utf8') : '';
    expect(blocked).toBe('');
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
