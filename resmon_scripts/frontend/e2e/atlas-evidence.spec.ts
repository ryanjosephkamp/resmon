/**
 * Atlas: Library › Evidence, in the real app.
 *
 * A file brought from Your files into a new project; a passage found in its
 * text and saved, held to codepoint offsets computed here from the fixture's
 * own bytes; a PDF read one page at a time, by number; a page with no text
 * said to have none; a note saved and its body edited; the project renamed; a
 * file taken out with its records kept; a passage reopened and resolved; and a
 * records-only archive that carries the chosen file and nothing of the others.
 * Each record on screen is held to the engine's.
 *
 * The fixtures are the backend's own Evidence fixtures. `unicode.txt` puts an
 * emoji and a decomposed é before its passage, so a codepoint offset and a
 * UTF-16 one differ there, and it mixes CRLF, CR and LF line endings.
 *
 * **Scripted:** the native folder chooser, the confirmation before a file is
 * taken out, and the download destination. **Not covered here:** the PDF page
 * image, and a relaunch; J35 drives the relaunch through
 * `journeys/drivers/atlas.ts`. No network.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { FRONTEND_ROOT, REPO_ROOT, SCREENSHOT_DIR, launchEnv, registerStateDir } from './fixtures/resmon-app';

const FIXTURES = path.join(REPO_ROOT, 'resmon_scripts', 'verification_scripts', 'fixtures', 'evidence');
const PAGE_ONE = 'Alpha evidence — exact version.';
const PAGE_TWO = 'Beta evidence stays separate.';
const QUOTE = 'exact passage';

interface StoredNote {
  note_id: string; kind: string; file_id: string; page_number: number | null;
  start_codepoint: number | null; end_codepoint: number | null; quote: string | null; body: string; membership_state: string;
}

/** A Library or Evidence route, asked from the window so it carries the app's own origin. */
async function library<T>(win: Page, route: string): Promise<T> {
  return win.evaluate(async (r) => {
    const port = (window as unknown as { resmonAPI: { getBackendPort(): string } }).resmonAPI.getBackendPort();
    const response = await e2eFetch(`http://127.0.0.1:${port}${r}`, { headers: { 'X-Resmon-Library': '1' } });
    if (!response.ok) throw new Error(`${r} answered HTTP ${response.status}: ${await response.text()}`);
    return response.json();
  }, route) as Promise<T>;
}

test('Evidence: a project from Your files, passages by codepoint, pages by number, notes kept through a removal, and an export of only what was chosen', async () => {
  test.setTimeout(300_000);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-evidence-'));
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-evidence-parent-')));
  const downloads = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-evidence-downloads-')));
  const env: Record<string, string> = { ...launchEnv(stateDir, true), RESMON_UI: 'atlas' };
  const text = fs.readFileSync(path.join(FIXTURES, 'unicode.txt'), 'utf8');
  // The offsets this spec expects, from the fixture's own first line: the app's are compared with these.
  const prefix = text.slice(0, text.indexOf(QUOTE));
  const start = Array.from(prefix).length;
  expect(start, 'the fixture no longer separates codepoints from UTF-16 units').not.toBe(prefix.length);

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
    win.on('dialog', (d) => { void d.accept(); });

    // — the library, and three files in it --------------------------------------------
    await win.evaluate(() => { window.location.hash = '#/library/files'; });
    await win.getByRole('button', { name: 'Choose parent folder' }).click();
    await expect(win.locator('[data-library="parent"]')).toHaveText(parent, { timeout: 30_000 });
    await win.getByRole('button', { name: 'Create the library here' }).click();
    const importer = win.getByLabel('Import PDF, TXT or MD');
    await expect(importer).toBeEnabled({ timeout: 60_000 });
    await importer.setInputFiles(['unicode.txt', 'two-pages.pdf', 'image-only.pdf'].map((n) => path.join(FIXTURES, n)));
    await expect(win.locator('[data-library="imported"]')).toHaveText('3 retained, 0 exact duplicates reused.', { timeout: 60_000 });
    const { vault } = await library<{ vault: { vault_id: string } }>(win, '/api/library');
    const { files } = await library<{ files: { file_id: string; version_id: string; original_name: string }[] }>(
      win, `/api/library/files?expected_vault_id=${vault.vault_id}`);
    const idOf = (name: string) => files.find((f) => f.original_name === name)!;

    // — brought from Your files, and added only when asked ------------------------------
    await win.getByRole('navigation', { name: 'Library' }).getByRole('link', { name: 'Evidence' }).click();
    await expect(win.getByText('No project yet. Start one, then add files from your library.')).toBeVisible({ timeout: 30_000 });
    await win.getByRole('navigation', { name: 'Library' }).getByRole('link', { name: 'Your files' }).click();
    await win.locator('button.library-file', { hasText: 'unicode.txt' }).click();
    await win.getByRole('region', { name: 'Selected Library item' }).getByRole('link', { name: 'Open in Evidence' }).click();
    const handoff = win.getByRole('region', { name: 'Brought from Your files' });
    await expect(handoff).toContainText('unicode.txt');
    await expect(handoff).toContainText('Start a project for it');
    await win.getByLabel('A name for a new project').fill('Atlas evidence');
    await win.getByRole('button', { name: 'Start', exact: true }).click();
    await expect(win.locator('h2.ev-title')).toHaveText('Atlas evidence', { timeout: 30_000 });
    const { projects } = await library<{ projects: { project_id: string; name: string; file_count: number }[] }>(
      win, `/api/evidence/projects?expected_vault_id=${vault.vault_id}`);
    expect(projects.map((p) => [p.name, p.file_count])).toEqual([['Atlas evidence', 0]]);
    const project = projects[0]!.project_id;
    const notes = async () => (await library<{ notes: StoredNote[] }>(
      win, `/api/evidence/projects/${project}/notes?expected_vault_id=${vault.vault_id}`)).notes;
    await handoff.getByRole('button', { name: 'Add unicode.txt to this project' }).click();
    await expect(handoff).toHaveCount(0, { timeout: 30_000 });

    // — a passage, at the codepoints computed above -------------------------------------
    const reader = win.getByRole('region', { name: 'Evidence reader' });
    await expect(reader.getByRole('heading', { name: 'unicode.txt' })).toBeVisible({ timeout: 30_000 });
    const pane = reader.getByLabel('Canonical page text');
    // The engine's canonical text for a TXT file: every CRLF and CR read as LF, nothing else changed.
    await expect(pane).toHaveValue(text.replace(/\r\n/g, '\n').replace(/\r/g, '\n'), { timeout: 60_000 });
    await expect(reader.locator('[data-evidence="examined"]')).toContainText('1 of 1 page examined by text extraction.');
    await reader.getByLabel('Find on this page’s text').fill('needle');
    await reader.getByRole('button', { name: 'Find', exact: true }).click();
    await expect(reader.locator('[data-evidence="found"]')).toHaveText('2 literal matches on this page’s text only.');
    await reader.getByLabel('Find on this page’s text').fill(QUOTE);
    await reader.getByRole('button', { name: 'Find', exact: true }).click();
    await expect(reader.locator('[data-evidence="found"]')).toHaveText('1 literal match on this page’s text only.');
    await reader.getByRole('button', { name: 'Use selected passage' }).click();
    const panel = win.getByRole('region', { name: 'Saved evidence notes' });
    await expect(panel.locator('[data-evidence="quote"]')).toHaveText(QUOTE);
    await expect(panel.getByText(`Page 1, codepoints ${start} to ${start + Array.from(QUOTE).length}.`)).toBeVisible();
    await panel.getByLabel('Your note on it (optional)').fill('After the owl and the accent.');
    await panel.getByRole('button', { name: 'Save passage' }).click();
    await expect.poll(async () => (await notes()).length, { timeout: 30_000 }).toBe(1);
    const [passage] = await notes();
    expect([passage!.kind, passage!.quote, passage!.start_codepoint, passage!.end_codepoint, passage!.file_id])
      .toEqual(['passage', QUOTE, start, start + Array.from(QUOTE).length, idOf('unicode.txt').file_id]);
    await expect(panel.locator('[data-evidence="saved"]')).toHaveText('Saved the passage against this exact version.');

    // — two more files, and a PDF read by page number -----------------------------------
    await win.getByRole('button', { name: 'Add files', exact: true }).click();
    const chooser = win.getByRole('region', { name: 'Add files from your library' });
    for (const name of ['two-pages.pdf', 'image-only.pdf']) {
      await chooser.locator('label.choice', { hasText: name }).getByRole('checkbox').check();
    }
    await chooser.getByRole('button', { name: 'Add 2 files' }).click();
    await expect(chooser.getByText('Every kept file is already in this project.')).toBeVisible({ timeout: 30_000 });
    await win.getByRole('button', { name: 'Add files', exact: true }).click();
    const members = win.getByRole('region', { name: 'Files in this project' }).locator('button.library-file');
    await expect(members).toHaveCount(3);

    await members.filter({ hasText: 'two-pages.pdf' }).click();
    await expect(reader.getByRole('heading', { name: 'two-pages.pdf' })).toBeVisible();
    await expect(pane).toHaveValue(PAGE_ONE, { timeout: 60_000 });
    await expect(reader.locator('[data-evidence="examined"]'))
      .toContainText('1 of 2 pages examined by text extraction. Other pages: not examined.');
    await reader.getByLabel('Page', { exact: true }).fill('2');
    await reader.getByLabel('Page', { exact: true }).press('Enter');
    await expect(pane).toHaveValue(PAGE_TWO, { timeout: 60_000 });
    await expect(pane).toHaveAttribute('data-page', '2');
    await expect(reader.getByRole('button', { name: 'Next page' })).toBeDisabled();
    // A page past the end is not asked for.
    await reader.getByLabel('Page', { exact: true }).fill('9');
    await reader.getByLabel('Page', { exact: true }).press('Enter');
    await expect(reader.getByLabel('Page', { exact: true })).toHaveValue('2');
    await reader.getByRole('button', { name: 'Previous page' }).click();
    await expect(pane).toHaveValue(PAGE_ONE, { timeout: 60_000 });

    // — a page with no text says so, and offers no passage -------------------------------
    await members.filter({ hasText: 'image-only.pdf' }).click();
    await expect(reader.getByText('No text on this page. That is not evidence the page has no content.')).toBeVisible({ timeout: 60_000 });
    await expect(reader.getByRole('button', { name: 'Use selected passage' })).toHaveCount(0);

    // — a note, and its body edited -----------------------------------------------------
    await members.filter({ hasText: 'two-pages.pdf' }).click();
    await expect(panel.getByRole('heading', { name: 'New plain note' })).toBeVisible();
    await panel.getByLabel('Note', { exact: true }).fill('Read both pages.');
    await panel.getByRole('button', { name: 'Save note' }).click();
    await expect.poll(async () => (await notes()).length, { timeout: 30_000 }).toBe(2);
    const record = panel.locator('ol.ev-saved > li[data-kind="note"]');
    await record.getByRole('button', { name: 'Edit the body' }).click();
    await expect(panel.getByRole('heading', { name: 'Edit the saved body · two-pages.pdf' })).toBeVisible();
    await panel.getByLabel('Note', { exact: true }).fill('Read both pages, twice.');
    await panel.getByRole('button', { name: 'Save body' }).click();
    await expect.poll(async () => (await notes()).find((n) => n.kind === 'note')?.body, { timeout: 30_000 }).toBe('Read both pages, twice.');
    await expect(record.locator('.ev-body-text')).toHaveText('Read both pages, twice.');

    // — renamed ---------------------------------------------------------------------------
    await win.getByRole('button', { name: 'Rename', exact: true }).click();
    await win.getByLabel('The project’s name').fill('Atlas evidence, renamed');
    await win.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(win.locator('h2.ev-title')).toHaveText('Atlas evidence, renamed', { timeout: 30_000 });
    await expect(win.locator('button.ev-project[aria-pressed="true"] .lib-name')).toHaveText('Atlas evidence, renamed', { timeout: 30_000 });

    // — taken out, with its record kept ---------------------------------------------------
    await members.filter({ hasText: 'two-pages.pdf' }).click();
    await reader.getByRole('button', { name: 'Remove from project' }).click();
    await expect(members).toHaveCount(2, { timeout: 30_000 });
    await expect.poll(async () => (await notes()).find((n) => n.kind === 'note')?.membership_state, { timeout: 30_000 }).toBe('removed');
    await expect(record).toContainText('file removed from the project');

    // — brought again: an exact version already held is said to be held ------------------
    await win.getByRole('navigation', { name: 'Library' }).getByRole('link', { name: 'Your files' }).click();
    await win.locator('button.library-file', { hasText: 'unicode.txt' }).click();
    await win.getByRole('region', { name: 'Selected Library item' }).getByRole('link', { name: 'Open in Evidence' }).click();
    await win.locator('button.ev-project', { hasText: 'Atlas evidence, renamed' }).click();
    await expect(handoff.getByText('This exact version is already in the project.')).toBeVisible({ timeout: 30_000 });
    await handoff.getByRole('button', { name: 'Read it' }).click();
    await expect(handoff).toHaveCount(0);

    // — reopened, and resolved against the same page ------------------------------------
    await panel.locator('ol.ev-saved > li[data-kind="passage"]').getByRole('button', { name: 'Reopen the passage' }).click();
    await expect(reader.locator('[data-evidence="resolution"]')).toHaveText(
      'Saved passage resolved against this exact version, extraction contract, text hash and codepoint range.', { timeout: 60_000 });
    expect(await pane.evaluate((el) => {
      const t = el as HTMLTextAreaElement;
      return t.value.slice(t.selectionStart, t.selectionEnd);
    })).toBe(QUOTE);
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-evidence.png') });

    // — a records-only archive of one file ------------------------------------------------
    await win.getByRole('button', { name: 'Export selected evidence', exact: true }).click();
    const bundle = win.getByRole('region', { name: 'Export selected evidence' });
    await bundle.locator('label.choice', { hasText: 'unicode.txt' }).getByRole('checkbox').check();
    const saved = path.join(downloads, 'evidence.zip');
    await app.evaluate(({ BrowserWindow }, target) => {
      BrowserWindow.getAllWindows()[0]!.webContents.session.once('will-download', (_e, item) => item.setSavePath(target));
    }, saved);
    await bundle.getByRole('button', { name: 'Save the archive' }).click();
    await expect(bundle.locator('[data-evidence="exported"]')).toHaveText(/^Saved a records-only archive of 1 file, /, { timeout: 60_000 });
    await expect.poll(() => win.evaluate((wanted) => (window as unknown as {
      resmonAPI: { getDownloads(): Promise<{ path: string; state: string }[]> };
    }).resmonAPI.getDownloads().then((items) => items.find((item) => item.path === wanted)?.state ?? ''), saved), { timeout: 60_000 }).toBe('completed');
    const read = JSON.parse(execFileSync(env.RESMON_PYTHON ?? 'python3', ['-c', `
import json, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    print(json.dumps({'names': z.namelist(), 'manifest': z.read('manifest.json').decode('utf-8'), 'notes': z.read('notes.md').decode('utf-8')}))
`, saved], { encoding: 'utf8' })) as { names: string[]; manifest: string; notes: string };
    expect(read.names.sort()).toEqual(['manifest.json', 'notes.md']);
    expect(read.manifest).toContain(idOf('unicode.txt').file_id);
    expect(read.manifest + read.notes).toContain(QUOTE);
    for (const left of ['two-pages.pdf', 'image-only.pdf', 'Read both pages']) {
      expect(read.manifest + read.notes, `${left} is in an archive that did not choose it`).not.toContain(left);
    }

    expect(problems).toEqual([]);
  } finally {
    await app.close();
    for (const dir of [stateDir, parent, downloads]) fs.rmSync(dir, { recursive: true, force: true });
  }
});
