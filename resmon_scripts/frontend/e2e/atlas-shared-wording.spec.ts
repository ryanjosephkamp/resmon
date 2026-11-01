/**
 * Atlas: Search › Shared wording, a paper's note, and Library › Compare with
 * your collection, in the real app.
 *
 * Four authored arXiv records, collected by a Deep Dive over the engine's API
 * from a loopback server in this spec: two by different authors that share one
 * 30-word passage, a later one by the first author that shares a 24-word
 * passage with her first, and one of 37 words, which is too short to compare. The scan is started
 * from the screen with its own button; what the screen then says (what was
 * compared, each group's count, a pair's numbers and sentences, the passages
 * marked in both texts) is held to the engine's own answer for the same pair.
 * A text file holding the 30-word passage is then kept in the Library and
 * compared from its own button, and the page and passage it names are held to
 * the engine's answer.
 *
 * J49 drives the same screen through `journeys/drivers/atlas.ts`; this spec
 * is the part that runs on every pull request. Every connection the engine
 * tries that is not loopback, and port 8742, is refused, and the spec fails if
 * anything was.
 */
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { FRONTEND_ROOT, REPO_ROOT, SCREENSHOT_DIR, launchEnv, registerStateDir } from './fixtures/resmon-app';

// Every sentence here is invented for this spec, and no name is a real person's.
const SHARED = 'A thin layer of glass beads was spread across a level floor and swept by a steady fan until the '
  + 'ripples settled into evenly spaced crests that moved downstream together.';
const REUSED = 'Each crest was photographed from above every ten seconds, and the photographs were traced by hand '
  + 'into outlines that a short script then compared.';

interface Authored { id: string; title: string; author: string; date: string; abstract: string }

const RECORDS: Authored[] = [
  {
    id: '2610.51001v1', title: 'Authored note on wind-driven ripple fields in a sealed tank', author: 'Ada Fixture',
    date: '2026-09-01',
    abstract: `We describe an invented tank experiment written only for this suite. ${SHARED} The remaining sentences `
      + `of this record are its own and appear nowhere else in the fixture corpus. ${REUSED} Nothing here was fetched.`,
  },
  {
    id: '2610.51002v1', title: 'Authored account of granular crests under a household fan', author: 'Bo Placeholder',
    date: '2026-09-15',
    abstract: `This record is invented for the suite and carries no published text. ${SHARED} Its other sentences differ `
      + 'from every other record, so that only the passage before them is in another abstract of this corpus.',
  },
  {
    id: '2610.51003v1', title: 'Authored second note from the same invented tank series', author: 'Ada Fixture',
    date: '2026-10-01',
    abstract: `A later record by the same invented author, written for this suite to show wording kept by one author. `
      + `${REUSED} The rest of this abstract is new and tells of a slower fan and fewer beads than the first note did.`,
  },
  {
    id: '2610.51004v1', title: 'Authored record about lantern wicks with nothing in common', author: 'Cy Fixture',
    date: '2026-09-20',
    abstract: 'An unrelated invented record about lantern wicks, their braiding, the oils they draw, and the soot they '
      + 'leave on a cold glass chimney, written so that no run of its words appears in any other abstract here.',
  },
];

const FEED = `<feed xmlns="http://www.w3.org/2005/Atom">${RECORDS.map((r) => `<entry>
  <id>https://arxiv.org/abs/${r.id}</id><title>${r.title}</title>
  <author><name>${r.author}</name></author><published>${r.date}T00:00:00Z</published>
  <summary>${r.abstract}</summary>
</entry>`).join('')}</feed>`;

/** A call to this window's engine, with its token, from inside the window. */
async function api<T>(win: Page, route: string, init?: { method?: string; body?: unknown; library?: boolean }): Promise<T> {
  return win.evaluate(async ({ route, init }) => {
    const port = (window as unknown as { resmonAPI: { getBackendPort(): string } }).resmonAPI.getBackendPort();
    if (!port || port === '8742') throw new Error('unidentified backend');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (init?.library) headers['X-Resmon-Library'] = '1';
    const res = await e2eFetch(`http://127.0.0.1:${port}${route}`, {
      method: init?.method ?? 'GET', headers, body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    });
    if (!res.ok) throw new Error(`${route} answered HTTP ${res.status}: ${await res.text()}`);
    return res.json();
  }, { route, init }) as Promise<T>;
}

/** A span of a text by Unicode codepoints, as the engine counts them. */
function codepoints(text: string, [start, end]: number[]): string {
  return Array.from(text).slice(start, end).join('');
}

interface Overview {
  state: string;
  job: { running: boolean };
  scan: { compared: number; not_compared: { no_abstract: number; too_short: number } } | null;
  groups: { category: string; count: number; pairs: { a: number; b: number }[] }[];
}
interface PairView {
  longest: number; share: number; summary: string[]; limits: string[];
  left: { id: number; text: string }; right: { id: number; text: string };
  passages: { left: number[]; right: number[]; words: number }[];
}

test('shared wording: scanned from the screen, a pair side by side, a paper\'s note, and a Library file compared', async () => {
  test.setTimeout(300_000);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-wording-'));
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-wording-parent-')));
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-wording-staging-'));
  const notes = path.join(staging, 'tank-notes.txt');
  fs.writeFileSync(notes, `Notes kept beside the invented tank, typed by hand.\n${SHARED}\nThat is all the notes say.\n`);

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
            raise OSError('atlas-shared-wording test guard refuses external/8742 connection')
    return original_connect(self, address)
socket.socket.connect = connect
sys.path.insert(0, ${JSON.stringify(path.join(REPO_ROOT, 'resmon_scripts'))})
from implementation_scripts import api_arxiv
api_arxiv._ARXIV_API_URL = ${JSON.stringify(`http://127.0.0.1:${sourcePort}/api/query`)}
`);
  const env: Record<string, string> = { ...launchEnv(stateDir, true) };
  env.PYTHONPATH = [hookDir, env.PYTHONPATH].filter(Boolean).join(path.delimiter);
  env.NO_PROXY = env.no_proxy = '127.0.0.1,localhost';

  const app = await electron.launch({
    args: ['.', `--user-data-dir=${path.join(stateDir, 'electron-user-data')}`],
    cwd: FRONTEND_ROOT, env, colorScheme: null, timeout: 180_000,
  });
  registerStateDir(stateDir);
  try {
    await app.evaluate(({ dialog }, chosen) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
    }, parent);
    const win = await app.firstWindow({ timeout: 180_000 });
    const problems: string[] = [];
    win.on('pageerror', (e) => problems.push(e.message));
    await win.getByRole('navigation', { name: 'Sections' }).waitFor({ timeout: 120_000 });

    // — the collection a person has before they arrive: one run, over the API --------
    const today = new Date();
    const monthAgo = new Date(today.getTime() - 60 * 86_400_000);
    const { execution_id: runId } = await api<{ execution_id: number }>(win, '/api/search/dive', {
      method: 'POST',
      body: {
        repository: 'arxiv', query: 'Authored', keywords: ['Authored'], max_results: 10,
        date_from: monthAgo.toISOString().slice(0, 10), date_to: today.toISOString().slice(0, 10),
      },
    });
    await expect.poll(async () => (await api<{ status: string }>(win, `/api/executions/${runId}`)).status,
      { timeout: 120_000 }).toBe('completed');
    const ids = new Map<string, number>();
    const corpus = await api<{ results?: { id: number; title: string }[] }>(win, '/api/explorer/search', {
      method: 'POST', body: { query: '', limit: 50 },
    });
    for (const row of corpus.results ?? []) ids.set(row.title, row.id);
    expect(ids.size, 'the run did not store the four authored records').toBe(4);
    const idOf = (n: number) => ids.get(RECORDS[n]!.title)!;

    // — the scan, from its own button ---------------------------------------------
    await win.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'Search' }).click();
    await win.getByRole('navigation', { name: 'Search' }).getByRole('link', { name: 'Shared wording' }).click();
    await expect(win.getByRole('heading', { name: 'Shared wording', level: 1 })).toBeVisible();
    await expect(win.locator('[data-wording="never"]')).toHaveText('Nothing has been scanned yet.');
    await win.locator('[data-wording="scan-button"]').click();
    // The engine's own record of the scan the button started.
    await expect.poll(async () => {
      const now = await api<Overview>(win, '/api/shared-wording');
      return now.state === 'ready' && !now.job.running;
    }, { timeout: 60_000 }).toBe(true);
    const stored = await api<Overview>(win, '/api/shared-wording');
    expect([stored.scan?.compared, stored.scan?.not_compared.too_short]).toEqual([3, 1]);

    // What the screen says is the engine's answer, group by group.
    await expect(win.locator('[data-wording="compared"]')).toHaveText(
      '3 abstracts were compared. 1 paper has an abstract under 40 words, so it was not compared.', { timeout: 30_000 });
    for (const group of stored.groups) {
      await expect(win.locator(`.wording-group[data-category="${group.category}"]`)).toHaveAttribute('data-count', String(group.count));
    }
    const counts = Object.fromEntries(stored.groups.map((g) => [g.category, g.count]));
    expect(counts).toEqual({ different_authors: 1, same_authors: 1, authors_unknown: 0, same_work: 0, notice: 0 });
    const a = Math.min(idOf(0), idOf(1));
    const b = Math.max(idOf(0), idOf(1));
    expect(stored.groups.find((g) => g.category === 'different_authors')!.pairs.map((p) => [p.a, p.b])).toEqual([[a, b]]);
    await expect(win.locator('.wording-group[data-category="different_authors"] .wording-row'))
      .toContainText("30-word passage word for word");
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-shared-wording.png') });

    // — a pair, side by side ----------------------------------------------------------
    await win.locator(`.wording-row[data-pair="${a}-${b}"]`).click();
    const view = win.locator(`.wording-pair[data-pair="${a}-${b}"]`);
    const engine = await api<PairView>(win, `/api/shared-wording/pairs/${a}/${b}`);
    expect(engine.longest).toBe(30);
    await expect(view.locator('[data-wording="summary"] p')).toHaveText(engine.summary, { timeout: 30_000 });
    expect(engine.summary[0]).toMatch(/^These two abstracts share a 30-word passage word for word and \d+% of the shorter one's 8-word phrases\.$/);
    expect(engine.summary[1]).toBe('They list no author in common.');
    expect(engine.summary[2]).toBe('The first was published September 1, 2026, and the second September 15, 2026.');
    await expect(view.locator('[data-wording="longest"]')).toHaveText('30 words');
    await expect(view.locator('[data-wording="share"]')).toHaveText(`${Math.floor(engine.share * 100 + 1e-9)}%`);
    await expect(view.locator('[data-wording="authors"]')).toHaveText('None');
    await expect(view.locator('[data-wording="limits"] li')).toHaveText(engine.limits);
    // The marked passages are the engine's spans of the engine's texts, on both sides.
    for (const side of ['left', 'right'] as const) {
      const marked = await view.locator(`.wording-side[data-side="${side}"] mark.wording-mark`).allInnerTexts();
      const expected = engine.passages.map((p) => codepoints(engine[side].text, p[side]));
      expect(marked.join(' | ')).toBe(expected.join(' | '));
      expect(expected.join(' ').replace(/[^\w ]/g, '').toLowerCase()).toBe(SHARED.replace(/[^\w ]/g, '').toLowerCase());
    }
    await expect(view.locator('.wording-side[data-side="left"]')).toHaveAttribute('data-paper', String(idOf(0)));
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-shared-wording-pair.png') });

    // — the paper's page says so, and links back to the pair --------------------------------
    await view.locator('.wording-side[data-side="left"] .wording-side-title a').click();
    const note = win.locator('[data-wording="paper-note"]');
    await expect(note.locator('li')).toHaveCount(2, { timeout: 30_000 });
    await expect(note.locator('li', { hasText: RECORDS[1]!.title })).toContainText('no author in common');
    await expect(note.locator('li', { hasText: RECORDS[2]!.title })).toContainText('1 author in common');
    await note.getByRole('link', { name: RECORDS[1]!.title }).click();
    await expect(win.locator(`.wording-pair[data-pair="${a}-${b}"]`)).toBeVisible();

    // — a Library file, compared from its own button ---------------------------------
    await win.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'Library' }).click();
    await win.getByRole('navigation', { name: 'Library' }).getByRole('link', { name: 'Your files' }).click();
    await win.getByRole('button', { name: 'Choose parent folder' }).click();
    await win.getByRole('button', { name: 'Create the library here' }).click();
    const importer = win.getByLabel('Import PDF, TXT, or MD');
    await expect(importer).toBeEnabled({ timeout: 60_000 });
    await importer.setInputFiles([notes]);
    await expect(win.locator('[data-library="imported"]')).toHaveText('1 retained, 0 exact duplicates reused.', { timeout: 60_000 });
    const detail = win.getByRole('region', { name: 'Selected Library item' });
    await expect(detail.locator('.lib-detail-name')).toHaveText('tank-notes.txt');
    const fileId = (await detail.locator('[data-library="file-id"]').innerText()).trim();
    const versionId = (await detail.locator('[data-library="version-id"]').innerText()).trim();
    const vaultId = (await api<{ vault: { vault_id: string } }>(win, '/api/library', { library: true })).vault.vault_id;
    await detail.locator('[data-library="compare"]').click();
    const route = `/api/library/files/${fileId}/shared-wording?expected_vault_id=${vaultId}&expected_version_id=${versionId}`;
    await expect.poll(async () => (await api<{ state: string }>(win, route, { library: true })).state, { timeout: 60_000 }).toBe('done');
    const compared = await api<{ result: { matches: { kind: string; page: number; document_id?: number; longest: number; passages: { text: string }[] }[] } }>(
      win, route, { library: true });
    const matches = compared.result.matches;
    expect(matches.map((m) => [m.kind, m.page, m.document_id, m.longest]).sort())
      .toEqual([['paper', 1, idOf(0), 30], ['paper', 1, idOf(1), 30]].sort());
    const shown = detail.locator('[data-library="wording-matches"] > li');
    await expect(shown).toHaveCount(2, { timeout: 30_000 });
    for (const m of matches) {
      const row = shown.filter({ has: win.locator(`a[href="#/papers/${m.document_id}"]`) });
      await expect(row.locator('.lib-wording-page')).toHaveText(/^Page 1 · 30-word passage word for word · \d+% of the shorter text's phrases$/);
      await expect(row.locator('blockquote')).toHaveText(m.passages.map((p) => p.text));
    }
    await expect(detail.locator('[data-library="wording-read"]'))
      .toHaveText('Read 1 of 1 page and compared it with 3 abstracts in your collection and 0 other files in this Library.');
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-shared-wording-library.png') });

    expect(problems).toEqual([]);
  } finally {
    await app.close();
    await new Promise<void>((resolve) => source.close(() => resolve()));
    const blocked = fs.existsSync(path.join(stateDir, 'blocked.jsonl'))
      ? fs.readFileSync(path.join(stateDir, 'blocked.jsonl'), 'utf8') : '';
    expect(blocked).toBe('');
    for (const dir of [stateDir, parent, staging]) fs.rmSync(dir, { recursive: true, force: true });
  }
});
