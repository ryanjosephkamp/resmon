/**
 * Atlas: two windows on two collections, in the real app.
 *
 * Two collections, three papers in the default one and two in Photonics. The
 * first window shows the default collection; a second window, opened with
 * New Window, switches to Photonics from its own switch. Each window then
 * shows its own collection's papers, the first window does not move when the
 * second switches, and the engine remembers Photonics as what a new window
 * opens on: a third window opens there. A window reloaded keeps its own
 * collection, as the main process holds it. No source is asked; any
 * connection the engine tries beyond this machine, and port 8742, is refused
 * by the startup hook, and the spec fails if anything was.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { ATLAS_LANDMARK, FRONTEND_ROOT, REPO_ROOT, SCREENSHOT_DIR, launchEnv, registerStateDir } from './fixtures/resmon-app';
import { removeStateDir } from './fixtures/cleanup';

const SEED = String.raw`
import json, os, sys
sys.path.insert(0, sys.argv[1])
from implementation_scripts.database import init_db, get_connection, insert_document
from implementation_scripts import paper_collections
path = os.environ["RESMON_DB_PATH"]
init_db(path)
conn = get_connection(path)
def paper(key, title, collection_id=None):
    return insert_document(conn, {
        "source_repository": "crossref", "external_id": f"e2e-windows-{key}", "title": title,
        "authors": "Cara Fixture", "publication_date": "2026-10-01",
        "abstract": f"{title}. An authored abstract for the suite.", "metadata_hash": f"e2e-windows-{key}",
    }, collection_id=collection_id)
photonics = paper_collections.create(conn, "Photonics")["id"]
default = [paper(n, t) for n, t in enumerate(("Diffusion models that denoise images",
                                               "Score matching for image diffusion",
                                               "Sampling diffusion models in fewer steps"))]
optics = [paper("p0", "Photonic lattices that guide light", photonics),
          paper("p1", "Waveguides in photonic crystals", photonics)]
conn.commit()
print(json.dumps({"default": default, "photonics": optics, "photonics_id": photonics}))
`;

async function engine<T>(win: Page, route: string): Promise<T> {
  return win.evaluate(async (r) => {
    const port = (window as unknown as { resmonAPI: { getBackendPort(): string } }).resmonAPI.getBackendPort();
    return (await e2eFetch(`http://127.0.0.1:${port}${r}`)).json();
  }, route) as Promise<T>;
}

/** The papers Search › Collection lists in a window, by id. */
async function listed(win: Page): Promise<number[]> {
  await win.evaluate(() => { window.location.hash = '#/search'; });
  await expect(win.locator('.results[aria-busy="false"]')).toBeVisible({ timeout: 30_000 });
  return win.locator('.result-list .result').evaluateAll((rows) => rows.map((row) => Number(row.getAttribute('data-document'))).sort((a, b) => a - b));
}

/** Click an application-menu item by id, as it is clicked with `window` in front. */
function clickMenu(app: ElectronApplication, item: string, window: number) {
  return app.evaluate(({ BrowserWindow, Menu }, [which, id]) => {
    const found = Menu.getApplicationMenu()?.getMenuItemById(which as string);
    if (!found) throw new Error(`no menu item ${which}`);
    found.click(undefined, BrowserWindow.fromId(id as number) ?? undefined);
  }, [item, window] as const);
}

async function idOf(app: ElectronApplication, page: Page): Promise<number> {
  return (await app.browserWindow(page)).evaluate((w) => w.id);
}

/** The collection the main process holds for a window. */
function heldFor(page: Page): Promise<string | null> {
  return page.evaluate(() => (window as unknown as { resmonAPI: { windowState(): { collection: string | null } } }).resmonAPI.windowState().collection);
}

test('two windows on two collections: each its own, and a new window opens on the last chosen', async () => {
  test.setTimeout(300_000);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-collection-windows-'));
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
            raise OSError('atlas-collection-windows test guard refuses external/8742 connection')
    return original_connect(self, address)
socket.socket.connect = connect
sys.path.insert(0, ${JSON.stringify(path.join(REPO_ROOT, 'resmon_scripts'))})
`);
  const env: Record<string, string> = { ...launchEnv(stateDir, true) };
  const seeded = spawnSync(env.RESMON_PYTHON ?? 'python3', ['-c', SEED, path.join(FRONTEND_ROOT, '..')], { env, encoding: 'utf8' });
  expect(seeded.status, seeded.stderr).toBe(0);
  const seed = JSON.parse(seeded.stdout.trim().split('\n').pop() ?? '{}') as { default: number[]; photonics: number[]; photonics_id: number };
  env.PYTHONPATH = [hookDir, env.PYTHONPATH].filter(Boolean).join(path.delimiter);
  env.NO_PROXY = env.no_proxy = '127.0.0.1,localhost';
  const shots = process.env.RESMON_COLLECTIONS_SHOTS ?? SCREENSHOT_DIR;
  fs.mkdirSync(shots, { recursive: true });

  const app = await electron.launch({
    args: ['.', `--user-data-dir=${path.join(stateDir, 'electron-user-data')}`],
    cwd: FRONTEND_ROOT, env, colorScheme: 'dark', timeout: 180_000,
  });
  registerStateDir(stateDir);
  const problems: string[] = [];
  try {
    const first = await app.firstWindow({ timeout: 180_000 });
    first.on('pageerror', (e) => problems.push(`first: ${e.message}`));
    await first.locator(ATLAS_LANDMARK).waitFor({ timeout: 120_000 });
    const firstId = await idOf(app, first);
    const firstScope = first.locator('.bar .scope');
    await expect(firstScope).toHaveText('Main Collection');
    // The first window took the collection it shows as its own.
    await expect.poll(() => heldFor(first)).toBe('1');
    expect(await listed(first)).toEqual([...seed.default].sort((a, b) => a - b));

    // — A second window, switched to Photonics from its own switch -----------------------
    const opened = app.waitForEvent('window');
    await clickMenu(app, 'file-new-window', firstId);
    const second = await opened;
    second.on('pageerror', (e) => problems.push(`second: ${e.message}`));
    await second.locator(ATLAS_LANDMARK).waitFor({ timeout: 60_000 });
    const secondScope = second.locator('.bar .scope');
    await expect(secondScope).toHaveText('Main Collection');
    await secondScope.click();
    await second.getByRole('menu', { name: 'Collections' }).getByRole('menuitemradio', { name: /Photonics/ }).click();
    await expect(secondScope).toHaveText('Photonics');
    await expect.poll(() => heldFor(second)).toBe(String(seed.photonics_id));
    expect(await listed(second)).toEqual([...seed.photonics].sort((a, b) => a - b));
    await expect(second.locator('.count-sentence')).toHaveText('2 papers in Photonics');

    // — The first window did not move -----------------------------------------------------
    await expect(firstScope).toHaveText('Main Collection');
    expect(await heldFor(first)).toBe('1');
    expect(await listed(first)).toEqual([...seed.default].sort((a, b) => a - b));
    await expect(first.locator('.count-sentence')).toHaveText('3 papers in Main Collection');
    await first.screenshot({ path: path.join(shots, 'windows-first-default-dark.png') });
    await second.screenshot({ path: path.join(shots, 'windows-second-photonics-dark.png') });

    // — The engine remembers the last chosen: a new window opens there ---------------------
    expect((await engine<{ current_id: number }>(first, '/api/collections')).current_id).toBe(seed.photonics_id);
    const thirdOpened = app.waitForEvent('window');
    await clickMenu(app, 'file-new-window', firstId);
    const third = await thirdOpened;
    third.on('pageerror', (e) => problems.push(`third: ${e.message}`));
    await third.locator(ATLAS_LANDMARK).waitFor({ timeout: 60_000 });
    await expect(third.locator('.bar .scope')).toHaveText('Photonics');
    await third.close();

    // — A window reloaded keeps its own collection, as the main process holds it -----------
    await first.reload();
    await first.locator(ATLAS_LANDMARK).waitFor({ timeout: 60_000 });
    await expect(firstScope).toHaveText('Main Collection');
    expect(await listed(first)).toEqual([...seed.default].sort((a, b) => a - b));

    // A copy in another window changes no run signature. Refocusing this
    // still-visible window must refresh its switch and Search together.
    await first.getByRole('heading', { name: 'Main Collection', exact: true }).waitFor();
    const copied = await second.evaluate(async (documentId) => {
      const port = (window as unknown as { resmonAPI: { getBackendPort(): string } }).resmonAPI.getBackendPort();
      const response = await e2eFetch(`http://127.0.0.1:${port}/api/collections/1/papers`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'copy', document_ids: [documentId] }),
      });
      return { status: response.status, body: await response.json() as { added: number[] } };
    }, seed.photonics[0]!);
    expect(copied.status).toBe(200);
    expect(copied.body.added).toEqual([seed.photonics[0]]);
    await first.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(first.locator('#collection-menu .scope-item').filter({ hasText: 'Main Collection' }).locator('.scope-count')).toHaveText('4');
    await expect(first.locator('.count-sentence')).toHaveText('4 papers in Main Collection');
    expect(await listed(first)).toEqual([...seed.default, seed.photonics[0]!].sort((a, b) => a - b));

    expect(problems).toEqual([]);
    expect(fs.existsSync(path.join(stateDir, 'blocked.jsonl'))
      ? fs.readFileSync(path.join(stateDir, 'blocked.jsonl'), 'utf8') : '').toBe('');
  } finally {
    await app.close();
    removeStateDir(stateDir);
  }
});
