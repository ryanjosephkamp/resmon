/**
 * Atlas: Library › Your Files, in the real app.
 *
 * A folder chosen and a library made inside it; three files imported, one the
 * engine refuses and the same bytes again; one read as literal text, linked
 * to a paper found by searching, opened and shown in Its Folder; and the
 * inventory saved from Settings › Library. Each
 * fact on screen is held to the engine's record, and the bytes kept are held
 * to the bytes given, read off the disk.
 *
 * **Scripted:** the native folder chooser
 * (`dialog.showOpenDialog` answers with this spec's folder), the system's
 * opener and Finder (`shell.openPath` and `shell.showItemInFolder` record what
 * they were handed and open nothing), and the download destination. The
 * production IPC handlers are untouched.
 *
 * J34 drives the same screen through `journeys/drivers/atlas.ts`; this spec is
 * the part that runs on every pull request. No network.
 */
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test, expect, _electron as electron } from '@playwright/test';
import { FRONTEND_ROOT, SCREENSHOT_DIR, atlasEnv, launchEnv, registerStateDir } from './fixtures/resmon-app';
import { findCard, shelfHolds } from './fixtures/gallery';
import { removeStateDir } from './fixtures/cleanup';

const SEED = String.raw`
import json, os, sys
sys.path.insert(0, sys.argv[1])
from implementation_scripts.database import init_db, get_connection, insert_document
path = os.environ["RESMON_DB_PATH"]
init_db(path)
conn = get_connection(path)
doc = insert_document(conn, {"source_repository": "arxiv", "external_id": "files-1",
    "title": "Perovskite cells that last outdoors", "authors": "Ada Fixture", "metadata_hash": "files-1"})
conn.commit()
print(json.dumps({"doc": doc}))
`;

const NOTE = 'Perovskite notes\r\nkept exactly as written\nλ and a third line\n';

test('Your Files: a library made where it was asked, files kept byte for byte, read, linked, opened and listed', async () => {
  test.setTimeout(240_000);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-files-'));
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-files-parent-')));
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-files-staging-'));
  const env = atlasEnv({ ...launchEnv(stateDir, true) });
  const seeded = spawnSync(env.RESMON_PYTHON ?? 'python3', ['-c', SEED, path.join(FRONTEND_ROOT, '..')], { env, encoding: 'utf8' });
  expect(seeded.status, seeded.stderr).toBe(0);
  const { doc } = JSON.parse(seeded.stdout.trim().split('\n').pop() ?? '{}') as { doc: number };
  const files = {
    note: path.join(staging, 'notes.txt'),
    outline: path.join(staging, 'outline.md'),
    paper: path.join(staging, 'paper.pdf'),
    refused: path.join(staging, 'tool.exe'),
  };
  fs.writeFileSync(files.note, NOTE);
  fs.writeFileSync(files.outline, '# Outline\n- one\n');
  fs.writeFileSync(files.paper, '%PDF-1.4\n% authored envelope\n%%EOF');
  fs.writeFileSync(files.refused, 'not a document');

  const app = await electron.launch({
    args: ['.', `--user-data-dir=${path.join(stateDir, 'electron-user-data')}`],
    cwd: FRONTEND_ROOT, env, colorScheme: null, timeout: 180_000,
  });
  registerStateDir(stateDir);
  try {
    await app.evaluate(({ dialog, shell }, chosen) => {
      const g = globalThis as unknown as { opened: string[]; revealed: string[] };
      g.opened = [];
      g.revealed = [];
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
      shell.openPath = async (target: string) => { g.opened.push(target); return ''; };
      shell.showItemInFolder = (target: string) => { g.revealed.push(target); };
    }, parent);
    const win = await app.firstWindow({ timeout: 180_000 });
    const problems: string[] = [];
    win.on('pageerror', (e) => problems.push(e.message));
    await win.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'Library' }).click();
    await win.getByRole('group', { name: 'Show' }).getByRole('button', { name: /Your Files/ }).click();

    // — made where it was asked ----------------------------------------------------
    const create = win.getByRole('button', { name: 'Create the Library Here' });
    await expect(create).toBeDisabled({ timeout: 60_000 });
    await win.getByRole('button', { name: 'Choose Parent Folder' }).click();
    await expect(win.locator('[data-library="parent"]')).toHaveText(parent);
    await create.click();
    const importer = win.getByLabel('Import PDF, TXT, MD, or TeX');
    await expect(importer).toBeEnabled({ timeout: 60_000 });
    const made = fs.readdirSync(parent).filter((name) => name.startsWith('resmon-library-'));
    expect(made).toHaveLength(1);
    const vault = path.join(parent, made[0]!);
    expect(fs.readdirSync(vault).sort()).toEqual(['files', 'vault.json']);

    // — kept byte for byte, and one refused -------------------------------------------
    await importer.setInputFiles([files.note, files.outline, files.paper, files.refused]);
    await expect(win.locator('[data-library="imported"]')).toHaveText('3 files added. None was already in the Library. 1 could not be added.', { timeout: 60_000 });
    await expect(win.locator('.library-refusals')).toContainText('tool.exe');
    await shelfHolds(win, 3);
    await importer.setInputFiles([files.note]);
    await expect(win.locator('[data-library="imported"]')).toHaveText('No files added. 1 was already in the Library.', { timeout: 60_000 });
    await shelfHolds(win, 3);

    // — one file's page and its record, against the disk ------------------------------
    await (await findCard(win, 'notes.txt')).getByRole('button', { name: 'Read' }).click();
    await expect(win.getByRole('heading', { name: 'notes.txt', level: 1 })).toBeVisible();
    const record = win.locator('details.lib-record');
    await record.locator('summary').click();
    await expect(record.locator('[data-library="media"]')).toHaveText('text/plain');
    const sha = (await record.locator('[data-library="sha256"]').innerText()).trim();
    expect(sha).toBe(createHash('sha256').update(fs.readFileSync(files.note)).digest('hex'));
    const fileId = (await record.locator('[data-library="file-id"]').innerText()).trim();
    const versionId = (await record.locator('[data-library="version-id"]').innerText()).trim();
    const kept = path.join(vault, 'files', fileId, `${versionId}.txt`);
    expect(fs.readFileSync(kept)).toEqual(fs.readFileSync(files.note));

    // Read as literal text: CRLF shown as one break, nothing rendered.
    const text = win.getByRole('region', { name: 'The text of notes.txt' });
    await expect(text.locator('.lib-lines li')).toHaveText(['Perovskite notes', 'kept exactly as written', 'λ and a third line', ' ']);
    await expect(text.getByRole('button', { name: 'Plain Text' })).toHaveCount(0);

    // — linked: chosen by searching, and said as an association ------------------------
    await win.getByRole('button', { name: 'Link to a Paper' }).first().click();
    const picker = win.getByRole('dialog', { name: 'Link notes.txt to a Paper' });
    await picker.getByLabel('Find a paper by title, author, or words in it').fill('perovskite');
    await picker.locator(`button[data-document="${doc}"]`).click();
    await expect(picker).toHaveCount(0);
    await expect(win.locator('[data-library="links"] li')).toHaveText(['Perovskite cells that last outdoors'], { timeout: 30_000 });
    await expect(win.locator('.lib-file-side')).toContainText('A link is your association, not verified publication identity.');
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-files.png') });

    // — opened and shown, by the verified path ----------------------------------------
    await win.getByRole('button', { name: 'Open in the System’s Viewer' }).click();
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { opened: string[] }).opened)).toEqual([kept]);
    await win.getByRole('button', { name: /^Show in / }).click();
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { revealed: string[] }).revealed)).toEqual([kept]);

    // — the inventory, from Settings › Library ----------------------------------------
    const saved = path.join(staging, 'inventory.json');
    await app.evaluate(({ BrowserWindow }, target) => {
      BrowserWindow.getAllWindows()[0]!.webContents.session.once('will-download', (_e, item) => item.setSavePath(target));
    }, saved);
    await win.evaluate(() => { window.location.hash = '#/settings/library'; });
    await expect(win.locator('[data-library="path"]')).toHaveText(vault);
    await win.getByRole('button', { name: 'Save an Inventory' }).click();
    await expect.poll(() => fs.existsSync(saved) && fs.statSync(saved).size > 0, { timeout: 30_000 }).toBe(true);
    const inventory = JSON.parse(fs.readFileSync(saved, 'utf8')) as { kind: string; files: { sha256: string }[] };
    expect(inventory.kind).toBe('resmon-library-inventory');
    expect(inventory.files.map((f) => f.sha256)).toContain(sha);

    // — kept through the Danger Zone: erasing the corpus and resetting every setting leave the library ----
    const before = fs.readFileSync(kept);
    await win.evaluate(() => { window.location.hash = '#/settings/danger'; });
    for (const [label, route] of [['Erase the Paper Corpus', '/api/admin/erase-corpus'], ['Reset All Settings', '/api/admin/reset-settings']] as const) {
      const row = win.locator('.danger-row').filter({ has: win.getByRole('button', { name: label, exact: true }) });
      await row.getByRole('button', { name: label, exact: true }).click();
      const form = win.getByRole('group', { name: `Confirm: ${label}` });
      await form.getByPlaceholder('Type CONFIRM').fill('CONFIRM');
      const done = win.waitForResponse((r) => r.url().endsWith(route));
      await form.getByRole('button', { name: 'Confirm', exact: true }).click();
      expect((await done).status(), `${label} was refused`).toBe(200);
    }
    // The old address of Your Files still leads there.
    await win.evaluate(() => { window.location.hash = '#/library/files'; });
    await shelfHolds(win, 3);
    for (const name of ['outline.md', 'paper.pdf', 'notes.txt']) await findCard(win, name);
    expect(fs.readFileSync(kept).equals(before), 'the kept copy changed through the Danger Zone').toBe(true);
    // The paper it was linked to went with the corpus; the link does not outlive it.
    await expect((await findCard(win, 'notes.txt')).locator('.card-label')).toHaveText('Not linked to a paper', { timeout: 30_000 });

    expect(problems).toEqual([]);
  } finally {
    await app.close();
    for (const dir of [stateDir, parent, staging]) removeStateDir(dir);
  }
});
