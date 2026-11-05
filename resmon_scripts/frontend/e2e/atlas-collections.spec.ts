/**
 * Atlas: collections inside one database, in the real app.
 *
 * A corpus of three papers in the default collection, and arXiv as a loopback
 * server that answers with two papers on photonics. Followed through what a
 * person does with collections: make one from the switch beside the lockup,
 * switch to it, run a Deep Dive into it from Ask the sources (which says where
 * its papers land), and see only its papers on Search › Your collection, Today,
 * and the map; switch back and see only the default's; move a picked paper to
 * the new collection and undo it, copy one from its page, and delete the new
 * collection, whose papers only it held are kept in the default one. Every
 * other connection the engine tries, and port 8742, is refused by the startup
 * hook, and the spec fails if anything was.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { FRONTEND_ROOT, REPO_ROOT, SCREENSHOT_DIR, launchEnv, registerStateDir } from './fixtures/resmon-app';
import { removeStateDir } from './fixtures/cleanup';

const FEED = `<feed xmlns="http://www.w3.org/2005/Atom">
<entry>
  <id>https://arxiv.org/abs/2611.70001v1</id><title>Photonic lattices that guide light around corners</title>
  <author><name>Ada Fixture</name></author><published>${new Date().toISOString().slice(0, 10)}T00:00:00Z</published>
  <summary>Authored local fixture about photonic lattices, not fetched scholarly content.</summary>
</entry>
<entry>
  <id>https://arxiv.org/abs/2611.70002v1</id><title>Waveguides in photonic crystals at telecom wavelengths</title>
  <author><name>Ben Fixture</name></author><published>${new Date().toISOString().slice(0, 10)}T00:00:00Z</published>
  <summary>Authored local fixture about photonic waveguides, not fetched scholarly content.</summary>
</entry></feed>`;

const SEED = String.raw`
import json, os, sys
sys.path.insert(0, sys.argv[1])
from implementation_scripts.database import init_db, get_connection, insert_document
path = os.environ["RESMON_DB_PATH"]
init_db(path)
conn = get_connection(path)
ids = [insert_document(conn, {
    "source_repository": "crossref", "external_id": f"e2e-collections-{n}", "title": title,
    "authors": "Cara Fixture", "publication_date": "2026-10-01",
    "abstract": f"{title}. An authored abstract for the suite about diffusion models.",
    "metadata_hash": f"e2e-collections-{n}",
}) for n, title in enumerate(("Diffusion models that denoise images", "Score matching for image diffusion",
                               "Sampling diffusion models in fewer steps"))]
conn.commit()
print(json.dumps({"ids": ids}))
`;

async function engine<T>(win: Page, route: string, method = 'GET', body?: unknown): Promise<T> {
  return win.evaluate(async ([r, m, b]) => {
    const port = (window as unknown as { resmonAPI: { getBackendPort(): string } }).resmonAPI.getBackendPort();
    const response = await e2eFetch(`http://127.0.0.1:${port}${r}`, {
      method: m as string,
      headers: b === undefined ? {} : { 'Content-Type': 'application/json' },
      ...(b === undefined ? {} : { body: JSON.stringify(b) }),
    });
    return response.json();
  }, [route, method, body] as const) as Promise<T>;
}

interface Listed { collections: { id: number; name: string; papers: number }[]; current_id: number; default_id: number }

/** The ids of the papers Search › Your collection lists. */
async function listed(win: Page): Promise<number[]> {
  await expect(win.locator('.results[aria-busy="false"]')).toBeVisible({ timeout: 30_000 });
  return win.locator('.result-list .result').evaluateAll((rows) => rows.map((row) => Number(row.getAttribute('data-document'))).sort((a, b) => a - b));
}

async function widen(app: ElectronApplication, win: Page, width: number): Promise<void> {
  await app.evaluate(({ BrowserWindow, screen }, x) => {
    const area = screen.getPrimaryDisplay().workAreaSize;
    const w = BrowserWindow.getAllWindows()[0]!;
    const fits = x <= area.width;
    const zoom = fits ? 1 : area.width / x;
    w.setSize(fits ? x : area.width, Math.min(area.height, Math.round(860 * zoom)));
    w.webContents.setZoomFactor(zoom);
  }, width);
  await expect.poll(() => win.evaluate(() => window.innerWidth), { timeout: 10_000 }).toBeGreaterThanOrEqual(width - 2);
}

test('collections: made, switched, run into, moved and copied between, and deleted', async () => {
  test.setTimeout(300_000);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-collections-'));
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
            raise OSError('atlas-collections test guard refuses external/8742 connection')
    return original_connect(self, address)
socket.socket.connect = connect
sys.path.insert(0, ${JSON.stringify(path.join(REPO_ROOT, 'resmon_scripts'))})
from implementation_scripts import api_arxiv
api_arxiv._ARXIV_API_URL = ${JSON.stringify(`http://127.0.0.1:${sourcePort}/api/query`)}
`);
  const env: Record<string, string> = { ...launchEnv(stateDir, true) };
  const seeded = spawnSync(env.RESMON_PYTHON ?? 'python3', ['-c', SEED, path.join(FRONTEND_ROOT, '..')], { env, encoding: 'utf8' });
  expect(seeded.status, seeded.stderr).toBe(0);
  const { ids: corpus } = JSON.parse(seeded.stdout.trim().split('\n').pop() ?? '{}') as { ids: number[] };
  env.PYTHONPATH = [hookDir, env.PYTHONPATH].filter(Boolean).join(path.delimiter);
  env.NO_PROXY = env.no_proxy = '127.0.0.1,localhost';

  const shots = process.env.RESMON_COLLECTIONS_SHOTS ?? SCREENSHOT_DIR;
  fs.mkdirSync(shots, { recursive: true });
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${path.join(stateDir, 'electron-user-data')}`],
    cwd: FRONTEND_ROOT, env, colorScheme: 'dark', timeout: 180_000,
  });
  registerStateDir(stateDir);
  try {
    const win = await app.firstWindow({ timeout: 180_000 });
    const problems: string[] = [];
    win.on('pageerror', (e) => problems.push(e.message));
    await win.getByRole('navigation', { name: 'Sections' }).waitFor({ timeout: 120_000 });
    await widen(app, win, 1440);

    // — The switch, beside the lockup -------------------------------------
    const scope = win.locator('.bar .scope');
    await expect(scope).toHaveText('Your collection');
    await expect(scope).toHaveAccessibleName('Collection: Your collection. Choose another collection');
    await scope.click();
    const menu = win.getByRole('menu', { name: 'Collections' });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitemradio')).toHaveText(['Your collection3']);
    await win.screenshot({ path: path.join(shots, 'switch-menu-one-dark.png') });

    // — Make one, from the switch: Settings › Collections with the field ready
    await menu.getByRole('menuitem', { name: 'New collection' }).click();
    await expect(win).toHaveURL(/#\/settings\/collections$/);
    const name = win.getByLabel('Name of the new collection');
    await expect(name).toBeFocused();
    await name.fill('Photonics');
    await win.getByRole('button', { name: 'Make collection' }).click();
    await expect(win.locator('[data-settings="collections"] [role="status"]')).toContainText('Made Photonics.');
    const listedNow = await engine<Listed>(win, '/api/collections');
    const photonics = listedNow.collections.find((c) => c.name === 'Photonics')!.id;
    await expect(win.locator(`[data-collection-row="${photonics}"]`)).toContainText('0 papers · 0 watches');
    await win.screenshot({ path: path.join(shots, 'settings-collections-dark.png') });

    // — Switch to it ------------------------------------------------------
    await scope.click();
    await expect(menu.getByRole('menuitemradio')).toHaveText(['Your collection3', 'Photonics0']);
    await win.screenshot({ path: path.join(shots, 'switch-menu-two-dark.png') });
    await menu.getByRole('menuitemradio', { name: /Photonics/ }).click();
    await expect(scope).toHaveText('Photonics');
    await expect.poll(async () => (await engine<Listed>(win, '/api/collections')).current_id).toBe(photonics);

    await win.evaluate(() => { window.location.hash = '#/search'; });
    await expect(win.getByRole('heading', { name: 'Photonics', level: 1 })).toBeVisible();
    await expect(win.locator('.index-empty')).toHaveText('Photonics holds no papers yet.');

    // — A Deep Dive from this window lands in its collection -----------------
    await win.evaluate(() => { window.location.hash = '#/search/ask'; });
    await expect(win.getByRole('heading', { name: 'Ask the sources', level: 1 })).toBeVisible();
    await expect(win.locator('[data-search="lands"]')).toHaveText('Its papers land in Photonics');
    await win.getByRole('button', { name: 'Deep Dive', exact: true }).click();
    await win.locator('.source[data-source="arxiv"] input').check();
    const terms = win.getByLabel('Search terms');
    await terms.fill('photonic');
    await terms.press('Enter');
    await win.getByRole('button', { name: 'Any time', exact: true }).click();
    const started = win.waitForResponse((r) => r.url().endsWith('/api/search/dive') && r.request().method() === 'POST');
    await win.getByRole('button', { name: 'Ask arXiv' }).click();
    const startedBody = (await started).request().postDataJSON() as { collection?: number };
    expect(startedBody.collection).toBe(photonics);
    const { execution_id: runId } = await (await started).json() as { execution_id: number };
    const run = win.locator(`.run[data-run="${runId}"]`);
    await expect(run).not.toHaveAttribute('data-status', 'running', { timeout: 120_000 });
    await expect(run).toHaveAttribute('data-status', 'completed');

    const both = await engine<{ results: { id: number; title: string }[] }>(
      win, '/api/explorer/search', 'POST', { collection: photonics, limit: 50 });
    const found = both.results.map((r) => r.id).sort((a, b) => a - b);
    expect(both.results.map((r) => r.title).sort()).toEqual([
      'Photonic lattices that guide light around corners', 'Waveguides in photonic crystals at telecom wavelengths']);

    // — Only its papers: Search, Today, and the map ---------------------------
    await win.evaluate(() => { window.location.hash = '#/search'; });
    expect(await listed(win)).toEqual(found);
    // Every count names Photonics and is its own: 2 papers here, of the 5 resmon holds.
    await expect(win.locator('.count-sentence')).toHaveText('2 papers in Photonics');
    await expect(win.locator('[data-collection="ranking"]')).toContainText('none of the 2 papers in Photonics has a vector');
    await expect(win.locator('.collection figcaption')).toHaveText(/^Every paper in Photonics, /, { timeout: 90_000 });
    await win.screenshot({ path: path.join(shots, 'search-photonics-dark.png') });

    await win.evaluate(() => { window.location.hash = '#/today'; });
    const todayList = win.locator('.index [data-paper]');
    await expect(todayList).toHaveCount(2, { timeout: 30_000 });
    expect((await todayList.evaluateAll((rows) => rows.map((r) => Number(r.getAttribute('data-paper'))))).sort((a, b) => a - b))
      .toEqual(found);
    await expect.poll(async () => {
      const map = await engine<{ state: string; points: { id: number[] } }>(win, `/api/map?collection=${photonics}`);
      return map.state === 'ready' ? [...map.points.id].sort((a, b) => a - b) : map.state;
    }, { timeout: 90_000 }).toEqual(found);
    await expect(win.locator('.plate-waiting')).toHaveCount(0, { timeout: 60_000 });
    await win.screenshot({ path: path.join(shots, 'today-photonics-dark.png') });

    // Settings › AI › Embeddings counts every paper resmon holds, as a backfill embeds them, and says so.
    await win.evaluate(() => { window.location.hash = '#/settings/ai?focus=embeddings'; });
    await expect(win.locator('[data-embeddings="missing"]')).toContainText('5 papers in every collection');

    // — Back to the default: only its papers ----------------------------------
    await scope.click();
    await menu.getByRole('menuitemradio', { name: /Your collection/ }).click();
    await expect(scope).toHaveText('Your collection');
    await win.evaluate(() => { window.location.hash = '#/search'; });
    await expect(win.getByRole('heading', { name: 'Your collection', level: 1 })).toBeVisible();
    expect(await listed(win)).toEqual([...corpus].sort((a, b) => a - b));
    await expect(win.locator('.count-sentence')).toHaveText('3 papers in your collection');
    await expect(win.locator('[data-collection="ranking"]')).toContainText('none of your 3 papers has a vector');
    await expect.poll(async () => {
      const map = await engine<{ state: string; points: { id: number[] } }>(win, '/api/map');
      return map.state === 'ready' ? [...map.points.id].sort((a, b) => a - b) : map.state;
    }, { timeout: 90_000 }).toEqual([...corpus].sort((a, b) => a - b));

    // — Move a selected paper, from the selection's bar beside Save to read, and undo it ----------------
    await win.locator('[data-collection="select"]').click();
    const picking = win.getByRole('group', { name: 'The selected matches' });
    await expect(picking).toContainText('0 of 3 selected');
    const first = corpus[0]!;
    await win.locator(`.result[data-document="${first}"] input.pickbox`).check();
    await expect(picking).toContainText('1 of 3 selected');
    await expect(picking.getByRole('button', { name: /Save/ })).toBeVisible();
    await picking.getByRole('button', { name: 'Move to' }).click();
    await win.getByRole('menu', { name: 'Move to' }).getByRole('menuitem', { name: /Photonics/ }).click();
    const moved = win.locator('[data-collection="moved"]');
    await expect(moved).toContainText('Moved 1 paper to Photonics.');
    await win.waitForTimeout(400); // the notice's entrance, done
    await win.screenshot({ path: path.join(shots, 'move-notice-dark.png') });
    await expect.poll(() => listed(win)).toEqual([...corpus].filter((id) => id !== first).sort((a, b) => a - b));
    const afterMove = await engine<{ collections: { id: number }[] }>(win, `/api/documents/${first}`);
    expect(afterMove.collections.map((c) => c.id)).toEqual([photonics]);
    // Escape closes the pick bar right after the move, and the move's notice stays with its Undo.
    await win.keyboard.press('Escape');
    await expect(picking).toBeHidden();
    await expect(moved).toBeVisible();
    await moved.getByRole('button', { name: 'Undo' }).click();
    await expect(moved).toBeHidden();
    await expect.poll(() => listed(win)).toEqual([...corpus].sort((a, b) => a - b));

    // — Copy one from its page ---------------------------------------------------
    const second = corpus[1]!;
    await win.evaluate((id) => { window.location.hash = `#/papers/${id}`; }, second);
    const where = win.locator('[data-paper="collections"]');
    await expect(where.getByRole('heading', { name: 'In one collection' })).toBeVisible();
    await where.getByRole('button', { name: 'Copy to' }).click();
    await win.getByRole('menu', { name: 'Copy to' }).getByRole('menuitem', { name: /Photonics/ }).click();
    await expect(win.locator('[data-collection="moved"]')).toContainText('Copied 1 paper to Photonics.');
    await win.waitForTimeout(400);
    await expect(where.getByRole('heading', { name: 'In 2 collections' })).toBeVisible();
    await expect(where).toContainText('copied here');
    await win.screenshot({ path: path.join(shots, 'paper-collections-dark.png') });

    // — Delete it: its own papers are kept in the default --------------------------
    await win.evaluate(() => { window.location.hash = '#/settings/collections'; });
    await win.getByRole('button', { name: 'Delete Photonics' }).click();
    const ask = win.locator('[data-collection="ask"]');
    await expect(ask).toContainText('2 papers are in no other collection, and will be kept in Your collection.');
    await expect(ask).toContainText('1 paper is also in another collection, and will stay there.');
    await win.screenshot({ path: path.join(shots, 'delete-question-dark.png') });
    await ask.getByRole('button', { name: 'Delete Photonics' }).click();
    await expect(win.locator('[data-settings="collections"] [role="status"]'))
      .toContainText('Deleted Photonics. 2 papers only it held are kept in Your collection. 1 paper stays in the other collection it is in.');
    await expect(scope).toHaveText('Your collection');
    await win.evaluate(() => { window.location.hash = '#/search'; });
    expect(await listed(win)).toEqual([...corpus, ...found].sort((a, b) => a - b));
    const after = await engine<Listed>(win, '/api/collections');
    expect(after.collections.map((c) => [c.name, c.papers])).toEqual([['Your collection', 5]]);

    // — Light, and the narrowest window ------------------------------------------
    await engine(win, '/api/appearance', 'PUT', { theme: 'light', accent: null });
    await win.reload();
    await win.getByRole('navigation', { name: 'Sections' }).waitFor({ timeout: 60_000 });
    await engine(win, '/api/collections', 'POST', { name: 'Fluid dynamics and turbulence' });
    await win.reload();
    await scope.waitFor();
    await scope.click();
    await win.screenshot({ path: path.join(shots, 'switch-menu-light.png') });
    await win.keyboard.press('Escape');
    await widen(app, win, 960);
    // At the window's narrowest the switch still names its collection.
    expect(await scope.evaluate((el) => el.getBoundingClientRect().width)).toBeGreaterThanOrEqual(100);
    await win.screenshot({ path: path.join(shots, 'bar-960-light.png') });
    await scope.click();
    await win.screenshot({ path: path.join(shots, 'switch-menu-960-light.png') });
    await win.keyboard.press('Escape');

    // A long name gives way with the bar's other controls at every width the window takes.
    await scope.click();
    await win.getByRole('menu', { name: 'Collections' }).getByRole('menuitemradio', { name: /Fluid dynamics/ }).click();
    await expect(scope).toContainText('Fluid dynamics');
    for (const width of [960, 1000, 1100, 1199, 1200, 1240, 1279, 1360, 1361, 1439, 1440, 1600]) {
      await widen(app, win, width);
      const inner = await win.evaluate(() => window.innerWidth);
      const boxes = await win.locator('header.bar').evaluate((bar) => [...bar.querySelectorAll('.lockup, .scope, .tabs li, .mon, .newsearch, .cmdk, .iconbtn')]
        .map((node) => node.getBoundingClientRect()).map((r) => ({ left: r.left, right: r.right })));
      for (let i = 1; i < boxes.length; i += 1) expect(boxes[i]!.left, `the bar overlaps at ${inner}`).toBeGreaterThanOrEqual(boxes[i - 1]!.right);
      expect(boxes[boxes.length - 1]!.right, `the bar spills at ${inner}`).toBeLessThanOrEqual(inner);
    }
    await win.screenshot({ path: path.join(shots, 'bar-long-name-1600-light.png') });

    expect(problems).toEqual([]);
    expect(fs.existsSync(path.join(stateDir, 'blocked.jsonl'))
      ? fs.readFileSync(path.join(stateDir, 'blocked.jsonl'), 'utf8') : '').toBe('');
  } finally {
    await app.close();
    source.close();
    removeStateDir(stateDir);
  }
});
