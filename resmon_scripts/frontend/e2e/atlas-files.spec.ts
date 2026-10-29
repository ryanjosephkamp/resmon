/**
 * Atlas: Library › Your files, in the real app.
 *
 * A folder chosen and a library made inside it; three files imported, one the
 * engine refuses and the same bytes again; one read as literal text, linked
 * to a paper, opened and shown in its folder; and the inventory saved. Each
 * fact on screen is held to the engine's record, and the bytes kept are held
 * to the bytes given, read off the disk.
 *
 * **Scripted, as `library.spec.ts` scripts them:** the native folder chooser
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
import { FRONTEND_ROOT, SCREENSHOT_DIR, launchEnv, registerStateDir } from './fixtures/resmon-app';

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

test('Your files: a library made where it was asked, files kept byte for byte, read, linked, opened and listed', async () => {
  test.setTimeout(240_000);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-files-'));
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-files-parent-')));
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-files-staging-'));
  const env: Record<string, string> = { ...launchEnv(stateDir, true), RESMON_UI: 'atlas' };
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
    await win.getByRole('navigation', { name: 'Library' }).getByRole('link', { name: 'Your files' }).click();

    // — made where it was asked ----------------------------------------------------
    const create = win.getByRole('button', { name: 'Create the library here' });
    await expect(create).toBeDisabled({ timeout: 60_000 });
    await win.getByRole('button', { name: 'Choose parent folder' }).click();
    await expect(win.locator('[data-library="parent"]')).toHaveText(parent);
    await create.click();
    const importer = win.getByLabel('Import PDF, TXT or MD');
    await expect(importer).toBeEnabled({ timeout: 60_000 });
    const made = fs.readdirSync(parent).filter((name) => name.startsWith('resmon-library-'));
    expect(made).toHaveLength(1);
    const vault = path.join(parent, made[0]!);
    expect(fs.readdirSync(vault).sort()).toEqual(['files', 'vault.json']);
    await expect(win.locator('.vault-facts code')).toHaveText(made[0]!);

    // — kept byte for byte, and one refused -------------------------------------------
    await importer.setInputFiles([files.note, files.outline, files.paper, files.refused]);
    await expect(win.locator('[data-library="imported"]')).toHaveText('3 retained, 0 exact duplicates reused, 1 refused.', { timeout: 60_000 });
    await expect(win.locator('.library-refusals')).toContainText('tool.exe');
    await expect(win.locator('button.library-file')).toHaveCount(3);
    await importer.setInputFiles([files.note]);
    await expect(win.locator('[data-library="imported"]')).toHaveText('0 retained, 1 exact duplicate reused.', { timeout: 60_000 });
    await expect(win.locator('button.library-file')).toHaveCount(3);

    // — one file's record, against the disk --------------------------------------------
    await win.locator('button.library-file', { hasText: 'notes.txt' }).click();
    const detail = win.getByRole('region', { name: 'Selected Library item' });
    await expect(detail.locator('.lib-detail-name')).toHaveText('notes.txt');
    await expect(detail.locator('[data-library="media"]')).toHaveText('text/plain');
    const sha = (await detail.locator('[data-library="sha256"]').innerText()).trim();
    expect(sha).toBe(createHash('sha256').update(fs.readFileSync(files.note)).digest('hex'));
    const fileId = (await detail.locator('[data-library="file-id"]').innerText()).trim();
    const versionId = (await detail.locator('[data-library="version-id"]').innerText()).trim();
    const kept = path.join(vault, 'files', fileId, `${versionId}.txt`);
    expect(fs.readFileSync(kept)).toEqual(fs.readFileSync(files.note));

    // Read as literal text: CRLF shown as one break, nothing rendered.
    await detail.getByRole('button', { name: 'Read here' }).click();
    await expect(detail.locator('.lib-lines li')).toHaveText(['Perovskite notes', 'kept exactly as written', 'λ and a third line', ' ']);
    // A PDF is never read here; it opens in the system's viewer.
    await win.locator('button.library-file', { hasText: 'paper.pdf' }).click();
    await expect(detail.locator('.lib-detail-name')).toHaveText('paper.pdf');
    await expect(detail.getByRole('button', { name: 'Read here' })).toHaveCount(0);
    await win.locator('button.library-file', { hasText: 'notes.txt' }).click();
    await expect(detail.locator('.lib-detail-name')).toHaveText('notes.txt');

    // — linked: an association, said as one -------------------------------------------
    await detail.locator('#lib-paper').fill(String(doc));
    await detail.getByRole('button', { name: 'Link', exact: true }).click();
    await expect(detail.locator('[data-library="linked"]')).toHaveText(
      `Linked paper ${doc}. A link is your association, not verified publication identity.`, { timeout: 30_000 });
    await expect(detail.locator('[data-library="links"] li')).toHaveText([`Paper ${doc}: Perovskite cells that last outdoors`]);
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-files.png') });

    // — opened and shown, by the verified path ----------------------------------------
    await detail.getByRole('button', { name: 'Open', exact: true }).click();
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { opened: string[] }).opened)).toEqual([kept]);
    await detail.getByRole('button', { name: /^Show in / }).click();
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { revealed: string[] }).revealed)).toEqual([kept]);

    // — the inventory ------------------------------------------------------------------
    const saved = path.join(staging, 'inventory.json');
    await app.evaluate(({ BrowserWindow }, target) => {
      BrowserWindow.getAllWindows()[0]!.webContents.session.once('will-download', (_e, item) => item.setSavePath(target));
    }, saved);
    await win.getByRole('button', { name: 'Save an inventory' }).click();
    await expect.poll(() => fs.existsSync(saved) && fs.statSync(saved).size > 0, { timeout: 30_000 }).toBe(true);
    const inventory = JSON.parse(fs.readFileSync(saved, 'utf8')) as { kind: string; files: { sha256: string }[] };
    expect(inventory.kind).toBe('resmon-library-inventory');
    expect(inventory.files.map((f) => f.sha256)).toContain(sha);

    expect(problems).toEqual([]);
  } finally {
    await app.close();
    for (const dir of [stateDir, parent, staging]) fs.rmSync(dir, { recursive: true, force: true });
  }
});
