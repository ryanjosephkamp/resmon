/**
 * Atlas: Library › Evidence, in the real app.
 *
 * A file brought from Your Files into a new project; a passage found in its
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
 * Each PDF page is also drawn by the fixed PDF.js 6.3.289, from bytes checked
 * against the recorded hash, and the canvas is held to having drawn something
 * dark on its white page: the authored text. What the page looks like is not
 * judged further; `atlas-reader.spec.ts` covers the stacked pages, the
 * gallery, focus mode, selection and links.
 *
 * **Scripted:** the native folder chooser, the confirmation before a file is
 * taken out, and the download destination. **Not covered here:** a relaunch;
 * J35 drives that through `journeys/drivers/atlas.ts`. No network.
 *
 * Each step is logged with the time it began (`EVIDENCE 16:27:27.512 +31.0 s
 * …`) and held to a time of its own, inside the test's, so a stall fails with
 * a sentence naming the step. It is followed by where the window stood: its
 * address and title, the control the step was acting on (whether it is there,
 * shown, and enabled, and what is at its center), the engine's health, the
 * requests still waiting, and what the app wrote. Whatever state the test
 * stops in, the app is closed in bounded time and what it started is stopped.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test, expect, _electron as electron, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { FRONTEND_ROOT, REPO_ROOT, SCREENSHOT_DIR, atlasEnv, launchEnv, registerStateDir } from './fixtures/resmon-app';
import { findCard } from './fixtures/gallery';
import { closeWithin, removeStateDir } from './fixtures/cleanup';
import { capture, stepsWithin, tellWhere, watchWindow, type Target, type Watched } from './fixtures/steps';

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


/** Kept back from the test's timeout for saying where a stall stood and for the teardown. */
const TEARDOWN_MS = 60_000;
const PREFIX = 'EVIDENCE';

test('Evidence: a project from Your Files, passages by codepoint, pages by number, notes kept through a removal, and an export of only what was chosen', async () => {
  test.setTimeout(300_000);
  const { say, step } = stepsWithin(PREFIX, 300_000, TEARDOWN_MS);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-evidence-'));
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-evidence-parent-')));
  const downloads = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-evidence-downloads-')));
  const env = atlasEnv({ ...launchEnv(stateDir, true) });
  const text = fs.readFileSync(path.join(FIXTURES, 'unicode.txt'), 'utf8');
  // The offsets this spec expects, from the fixture's own first line: the app's are compared with these.
  const prefix = text.slice(0, text.indexOf(QUOTE));
  const start = Array.from(prefix).length;
  expect(start, 'the fixture no longer separates codepoints from UTF-16 units').not.toBe(prefix.length);

  let app: ElectronApplication | null = null;
  let win: Page | null = null;
  let watched: Watched | null = null;
  let wrote: (() => string) | null = null;
  // The control the step under way is acting on, for saying where it stood if the step stalls.
  let target: Target | null = null;
  const aim = (name: string, locator: Locator): Locator => { target = { name, locator }; return locator; };
  let passed = false;
  try {
    const launched = await step('the app starts', 180_000, (ms) => electron.launch({
      args: ['.', `--user-data-dir=${path.join(stateDir, 'electron-user-data')}`],
      cwd: FRONTEND_ROOT, env, colorScheme: null, timeout: ms,
    }));
    app = launched;
    registerStateDir(stateDir);
    wrote = capture(launched).all;
    say(`the app is up, pid ${launched.process().pid}, in ${stateDir}`);
    await step('the folder chooser is scripted', 15_000, () => launched.evaluate(({ dialog }, chosen) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
    }, parent));
    const page = await step('the first window opens', 180_000, (ms) => launched.firstWindow({ timeout: ms }));
    win = page;
    watched = watchWindow(page);
    const { problems } = watched;
    // The router sets its own address when it mounts, so nothing navigates before it has.
    await step('Atlas draws its frame', 120_000,
      (ms) => expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible({ timeout: ms }));
    page.on('dialog', (d) => { void d.accept(); });

    // What the steps below read and act on.
    const handoff = page.getByRole('region', { name: 'Brought from Your Files' });
    const reader = page.getByRole('region', { name: 'Evidence reader' });
    const pane = reader.getByLabel('Canonical page text');
    const panel = page.getByRole('region', { name: 'Saved evidence notes' });
    const members = page.getByRole('region', { name: 'Files in this project' }).locator('button.library-file');
    const record = panel.locator('ol.ev-saved > li[data-kind="note"]');
    const bundle = page.getByRole('region', { name: 'Export Selected Evidence' });

    // — the library, and three files in it --------------------------------------------
    const { vault, idOf } = await step('the library made, and three files imported', 150_000, async () => {
      await page.evaluate(() => { window.location.hash = '#/library?show=files'; });
      await aim('Choose Parent Folder', page.getByRole('button', { name: 'Choose Parent Folder' })).click();
      await expect(page.locator('[data-library="parent"]')).toHaveText(parent, { timeout: 30_000 });
      await aim('Create the Library Here', page.getByRole('button', { name: 'Create the Library Here' })).click();
      const importer = page.getByLabel('Import PDF, TXT, MD, or TeX');
      await expect(importer).toBeEnabled({ timeout: 60_000 });
      await importer.setInputFiles(['unicode.txt', 'two-pages.pdf', 'image-only.pdf'].map((n) => path.join(FIXTURES, n)));
      await expect(page.locator('[data-library="imported"]')).toHaveText('3 files added. None was already in the Library.', { timeout: 60_000 });
      const status = await library<{ vault: { vault_id: string } }>(page, '/api/library');
      const { files } = await library<{ files: { file_id: string; version_id: string; original_name: string }[] }>(
        page, `/api/library/files?expected_vault_id=${status.vault.vault_id}`);
      return { vault: status.vault, idOf: (name: string) => files.find((f) => f.original_name === name)! };
    });

    // — brought from Your Files, and added only when asked ------------------------------
    await step('Evidence says there is no project yet, and goes back to the Library', 60_000, async () => {
      await page.evaluate(() => { window.location.hash = '#/library/evidence'; });
      await expect(page.getByText('No project yet. Start one, then add files from your library.')).toBeVisible({ timeout: 30_000 });
      await aim('Back to the Library', page.getByRole('navigation', { name: 'Back to the Library' }).getByRole('link', { name: 'Library' })).click();
    });
    await step('unicode.txt found on Your Files, and read', 60_000, async () => {
      await aim('Your Files', page.getByRole('group', { name: 'Show' }).getByRole('button', { name: /Your Files/ })).click();
      await aim('Read on unicode.txt', (await findCard(page, 'unicode.txt')).getByRole('button', { name: 'Read' })).click();
    });
    await step('the file\'s page opens Evidence', 60_000,
      () => aim('Open in Evidence', page.getByRole('link', { name: 'Open in Evidence' }).first()).click());
    const project = await step('a project started for it, and the file added when asked', 90_000, async () => {
      await expect(handoff).toContainText('unicode.txt');
      await expect(handoff).toContainText('Start a project for it');
      await page.getByLabel('A name for a new project').fill('Atlas evidence');
      await aim('Start', page.getByRole('button', { name: 'Start', exact: true })).click();
      await expect(page.locator('h2.ev-title')).toHaveText('Atlas evidence', { timeout: 30_000 });
      const { projects } = await library<{ projects: { project_id: string; name: string; file_count: number }[] }>(
        page, `/api/evidence/projects?expected_vault_id=${vault.vault_id}`);
      expect(projects.map((p) => [p.name, p.file_count])).toEqual([['Atlas evidence', 0]]);
      await aim('Add unicode.txt to This Project', handoff.getByRole('button', { name: 'Add unicode.txt to This Project' })).click();
      await expect(handoff).toHaveCount(0, { timeout: 30_000 });
      return projects[0]!.project_id;
    });
    const notes = async () => (await library<{ notes: StoredNote[] }>(
      page, `/api/evidence/projects/${project}/notes?expected_vault_id=${vault.vault_id}`)).notes;

    // — a passage, at the codepoints computed above -------------------------------------
    await step('a passage found, stepped through, and saved at its codepoints', 150_000, async () => {
      await expect(reader.getByRole('heading', { name: 'unicode.txt' })).toBeVisible({ timeout: 30_000 });
      // The engine's canonical text for a TXT file: every CRLF and CR read as LF, nothing else changed.
      await expect(pane).toHaveValue(text.replace(/\r\n/g, '\n').replace(/\r/g, '\n'), { timeout: 60_000 });
      await expect(reader.locator('[data-evidence="examined"]')).toContainText('Page 1 of 1, read by text extraction.');
      // ⌘F from the file's own button in the project's list, as from the reader, goes to the text's find.
      await page.locator('.ev-members button.library-file', { hasText: 'unicode.txt' }).focus();
      await page.keyboard.press('ControlOrMeta+F');
      await expect(reader.getByLabel('Find on This Page’s Text')).toBeFocused();
      const found = reader.locator('[data-evidence="found"]');
      const selection = () => pane.evaluate((el) => [(el as HTMLTextAreaElement).selectionStart, (el as HTMLTextAreaElement).selectionEnd]);
      await reader.getByLabel('Find on This Page’s Text').fill('needle');
      await aim('Find', reader.getByRole('button', { name: 'Find', exact: true })).click();
      await expect(found).toHaveText('1 of 2 literal matches on this page’s text only.');
      const first = await selection();
      // Enter and Shift+Enter step through the matches, wrapping, from the text where the match is shown, and from the field.
      await expect(pane).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(found).toHaveText('2 of 2 literal matches on this page’s text only.');
      const second = await selection();
      expect(second).not.toEqual(first);
      await page.keyboard.press('Enter');
      await expect(found).toHaveText('1 of 2 literal matches on this page’s text only.');
      expect(await selection()).toEqual(first);
      await page.keyboard.press('Shift+Enter');
      await expect(found).toHaveText('2 of 2 literal matches on this page’s text only.');
      expect(await selection()).toEqual(second);
      await reader.getByLabel('Find on This Page’s Text').press('Shift+Enter');
      await expect(found).toHaveText('1 of 2 literal matches on this page’s text only.');
      expect(await selection()).toEqual(first);
      await reader.getByLabel('Find on This Page’s Text').fill(QUOTE);
      await reader.getByRole('button', { name: 'Find', exact: true }).click();
      await expect(found).toHaveText('1 of 1 literal match on this page’s text only.');
      await aim('Use Selected Passage', reader.getByRole('button', { name: 'Use Selected Passage' })).click();
      await expect(panel.locator('[data-evidence="quote"]')).toHaveText(QUOTE);
      // Cancel lets the passage go and keeps the note typed for it; Escape does the same.
      await panel.getByLabel('Your note on it (optional)').fill('A note typed, then the passage let go.');
      await panel.locator('.ev-note-form').screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-evidence-pending-passage.png') });
      await aim('Cancel', panel.getByRole('button', { name: 'Cancel', exact: true })).click();
      await expect(panel.getByRole('heading', { name: 'New Plain Note' })).toBeVisible();
      await expect(panel.getByLabel('Note', { exact: true })).toHaveValue('A note typed, then the passage let go.');
      await reader.getByRole('button', { name: 'Use Selected Passage' }).click();
      await expect(panel.getByRole('heading', { name: 'New Exact Passage' })).toBeVisible();
      await panel.getByLabel('Your note on it (optional)').press('Escape');
      await expect(panel.getByRole('heading', { name: 'New Plain Note' })).toBeVisible();
      await panel.getByLabel('Note', { exact: true }).fill('');
      await reader.getByRole('button', { name: 'Use Selected Passage' }).click();
      await expect(panel.locator('[data-evidence="quote"]')).toHaveText(QUOTE);
      await expect(panel.getByText(`Page 1, codepoints ${start} to ${start + Array.from(QUOTE).length}.`)).toBeVisible();
      await panel.getByLabel('Your note on it (optional)').fill('After the owl and the accent.');
      await aim('Save Passage', panel.getByRole('button', { name: 'Save Passage' })).click();
      await expect.poll(async () => (await notes()).length, { timeout: 30_000 }).toBe(1);
      const [passage] = await notes();
      expect([passage!.kind, passage!.quote, passage!.start_codepoint, passage!.end_codepoint, passage!.file_id])
        .toEqual(['passage', QUOTE, start, start + Array.from(QUOTE).length, idOf('unicode.txt').file_id]);
      await expect(panel.locator('[data-evidence="saved"]')).toHaveText('Saved the passage against this exact version.');
    });

    await step('the side columns fold without losing a draft, and give the page their width', 30_000, async () => {
      const draft = panel.getByLabel('Note', { exact: true });
      await draft.fill('A draft kept while the notes are folded.');
      const before = await reader.evaluate((element) => element.getBoundingClientRect().width);
      await page.getByRole('button', { name: 'Fold Side Columns' }).click();
      await expect(page.getByRole('region', { name: 'Files in this project' })).toBeHidden();
      await expect(panel).toBeHidden();
      expect(await reader.evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(before + 100);
      await page.keyboard.press('ControlOrMeta+Shift+Backslash');
      await expect(panel).toBeVisible();
      await expect(draft).toHaveValue('A draft kept while the notes are folded.');
      await draft.fill('');
    });

    // — two more files, and a PDF read by page number -----------------------------------
    await step('two more files added, and a PDF read by page number', 180_000, async () => {
      await aim('Add Files', page.getByRole('button', { name: 'Add Files', exact: true })).click();
      const chooser = page.getByRole('region', { name: 'Add Files from the Library', exact: true });
      // The find narrows the list, which scrolls inside the panel above its button.
      const find = chooser.getByRole('searchbox', { name: 'Find a file or paper title' });
      await find.fill('two-pages');
      await expect(chooser.locator('label.choice')).toHaveCount(1);
      await chooser.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-evidence-add-files-find.png') });
      await find.fill('');
      for (const name of ['two-pages.pdf', 'image-only.pdf']) {
        await chooser.locator('label.choice', { hasText: name }).getByRole('checkbox').check();
      }
      await aim('Add 2 Files', chooser.getByRole('button', { name: 'Add 2 Files' })).click();
      await expect(chooser.getByText('Every kept file is already in this project.')).toBeVisible({ timeout: 30_000 });
      await page.getByRole('button', { name: 'Add Files', exact: true }).click();
      await expect(members).toHaveCount(3);

      await aim('two-pages.pdf in the project', members.filter({ hasText: 'two-pages.pdf' })).click();
      await expect(reader.getByRole('heading', { name: 'two-pages.pdf' })).toBeVisible();
      await expect(pane).toHaveValue(PAGE_ONE, { timeout: 60_000 });
      await expect(reader.locator('[data-evidence="examined"]'))
        .toContainText('Page 1 of 2, read by text extraction. Each page is read when you open it.');
      const image = reader.getByRole('region', { name: 'PDF page image' });
      await expect(image.getByRole('status')).toHaveText(/^Page 1 of 2 rendered · PDF\.js 6\.3\.289 · \d+ × \d+ pixels/, { timeout: 60_000 });
      const drawn = await image.locator('.ev-sheet[data-page="1"] canvas[data-pdf-version="6.3.289"]').evaluate((el) => {
        const c = el as HTMLCanvasElement;
        const pixels = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
        let dark = 0;
        for (let i = 0; i < pixels.length; i += 4) if (pixels[i]! < 150 && pixels[i + 1]! < 150 && pixels[i + 2]! < 150 && pixels[i + 3]! > 0) dark += 1;
        return { width: c.width, height: c.height, dark };
      });
      expect(drawn.width * drawn.height).toBeLessThanOrEqual(4_000_000);
      expect(drawn.dark, 'PDF.js said it drew the page and the canvas has no text on it').toBeGreaterThan(10);
      await reader.getByLabel('Page', { exact: true }).fill('2');
      await reader.getByLabel('Page', { exact: true }).press('Enter');
      await expect(pane).toHaveValue(PAGE_TWO, { timeout: 60_000 });
      await expect(pane).toHaveAttribute('data-page', '2');
      // The second page read says it is page 2, not that one page of two was examined.
      await expect(reader.locator('[data-evidence="examined"]'))
        .toContainText('Page 2 of 2, read by text extraction. Each page is read when you open it.');
      await expect(image.getByRole('status')).toHaveText(/^Page 2 of 2 rendered/, { timeout: 60_000 });
      await reader.getByLabel('Zoom', { exact: true }).selectOption('200');
      await expect(image.getByRole('status')).toHaveText(/^Page 2 of 2 rendered/, { timeout: 60_000 });
      await reader.getByLabel('Zoom', { exact: true }).selectOption('width');
      await expect(reader.getByRole('button', { name: 'Next Page' })).toBeDisabled();
      // A page past the end is not asked for.
      await reader.getByLabel('Page', { exact: true }).fill('9');
      await reader.getByLabel('Page', { exact: true }).press('Enter');
      await expect(reader.getByLabel('Page', { exact: true })).toHaveValue('2');
      await aim('Previous Page', reader.getByRole('button', { name: 'Previous Page' })).click();
      await expect(pane).toHaveValue(PAGE_ONE, { timeout: 60_000 });
    });

    // — a page with no text says so, and offers no passage -------------------------------
    await step('a page with no text says so, and offers no passage', 90_000, async () => {
      await aim('image-only.pdf in the project', members.filter({ hasText: 'image-only.pdf' })).click();
      await expect(reader.getByText('No text on this page. That is not evidence the page has no content.')).toBeVisible({ timeout: 60_000 });
      await expect(reader.getByRole('button', { name: 'Use Selected Passage' })).toHaveCount(0);
    });

    // — a note, and its body edited -----------------------------------------------------
    await step('a note saved, and its body edited', 90_000, async () => {
      await aim('two-pages.pdf in the project', members.filter({ hasText: 'two-pages.pdf' })).click();
      await expect(panel.getByRole('heading', { name: 'New Plain Note' })).toBeVisible();
      // Plain Enter is a new line in a note; ⌘Enter (Ctrl+Enter) saves it, as Save Note does.
      const body = panel.getByLabel('Note', { exact: true });
      await body.fill('Read both pages.');
      await body.press('Enter');
      await expect(body).toHaveValue('Read both pages.\n');
      expect((await notes()).length).toBe(1);
      await body.fill('Read both pages.');
      await expect(panel.locator('.ev-note-form .enter-hint')).toHaveText(process.platform === 'darwin' ? '⌘↩' : 'Ctrl+Enter');
      await panel.locator('.ev-note-form').screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-evidence-note-form.png') });
      await body.press('ControlOrMeta+Enter');
      await expect.poll(async () => (await notes()).length, { timeout: 30_000 }).toBe(2);
      await aim('Edit the Body', record.getByRole('button', { name: 'Edit the Body' })).click();
      await expect(panel.getByRole('heading', { name: 'Edit the Saved Body · two-pages.pdf' })).toBeVisible();
      await panel.getByLabel('Note', { exact: true }).fill('Read both pages, twice.');
      await panel.getByLabel('Note', { exact: true }).press('ControlOrMeta+Enter');
      await expect.poll(async () => (await notes()).find((n) => n.kind === 'note')?.body, { timeout: 30_000 }).toBe('Read both pages, twice.');
      await expect(record.locator('.ev-body-text')).toHaveText('Read both pages, twice.');
    });

    // — renamed ---------------------------------------------------------------------------
    await step('the project renamed', 60_000, async () => {
      await aim('Rename', page.getByRole('button', { name: 'Rename', exact: true })).click();
      await page.getByLabel('The project’s name').fill('Atlas evidence, renamed');
      await aim('Save', page.getByRole('button', { name: 'Save', exact: true })).click();
      await expect(page.locator('h2.ev-title')).toHaveText('Atlas evidence, renamed', { timeout: 30_000 });
      await expect(page.locator('button.ev-project[aria-pressed="true"] .lib-name')).toHaveText('Atlas evidence, renamed', { timeout: 30_000 });
    });

    // — taken out, with its record kept ---------------------------------------------------
    await step('a file taken out, with its record kept', 90_000, async () => {
      await aim('two-pages.pdf in the project', members.filter({ hasText: 'two-pages.pdf' })).click();
      await aim('Remove from Project', reader.getByRole('button', { name: 'Remove from Project' })).click();
      await expect(members).toHaveCount(2, { timeout: 30_000 });
      await expect.poll(async () => (await notes()).find((n) => n.kind === 'note')?.membership_state, { timeout: 30_000 }).toBe('removed');
      // Records sit under their file's heading, and the heading says the file has left the project.
      await expect(panel.locator('section.ev-group').filter({ has: page.locator('li[data-kind="note"]') }))
        .toContainText('file removed from the project');
    });

    // — brought again: an exact version already held is said to be held ------------------
    await step('brought again: the exact version already held is said to be held', 90_000, async () => {
      await page.evaluate(() => { window.location.hash = '#/library?show=files'; });
      await aim('Read on unicode.txt', (await findCard(page, 'unicode.txt')).getByRole('button', { name: 'Read' })).click();
      await aim('Open in Evidence', page.getByRole('link', { name: 'Open in Evidence' }).first()).click();
      await aim('the renamed project', page.locator('button.ev-project', { hasText: 'Atlas evidence, renamed' })).click();
      await expect(handoff.getByText('This exact version is already in the project.')).toBeVisible({ timeout: 30_000 });
      await aim('Read It', handoff.getByRole('button', { name: 'Read It' })).click();
      await expect(handoff).toHaveCount(0);
    });

    // — reopened, and resolved against the same page ------------------------------------
    await step('a passage reopened, and resolved against the same page', 90_000, async () => {
      await aim('Reopen the Passage', panel.locator('ol.ev-saved > li[data-kind="passage"]').getByRole('button', { name: 'Reopen the Passage' })).click();
      await expect(reader.locator('[data-evidence="resolution"]')).toHaveText(
        'Saved passage resolved against this exact version, extraction contract, text hash, and codepoint range.', { timeout: 60_000 });
      expect(await pane.evaluate((el) => {
        const t = el as HTMLTextAreaElement;
        return t.value.slice(t.selectionStart, t.selectionEnd);
      })).toBe(QUOTE);
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-evidence.png') });
      // Records sit under their file; This File Only keeps the open file's.
      const groups = panel.locator('section.ev-group');
      expect(await groups.count()).toBeGreaterThanOrEqual(2);
      await panel.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-evidence-records.png') });
      await panel.getByRole('button', { name: 'This File Only' }).click();
      await expect(groups).toHaveCount(1);
      await expect(groups.locator('.ev-saved-file')).toHaveText('unicode.txt');
      await panel.getByRole('button', { name: 'All Files' }).click();
    });

    // — a records-only archive of one file ------------------------------------------------
    await step('a records-only archive of one file', 120_000, async () => {
      await aim('Export Selected Evidence', page.getByRole('button', { name: 'Export Selected Evidence', exact: true })).click();
      await bundle.locator('label.choice', { hasText: 'unicode.txt' }).getByRole('checkbox').check();
      const saved = path.join(downloads, 'evidence.zip');
      await launched.evaluate(({ BrowserWindow }, chosen) => {
        BrowserWindow.getAllWindows()[0]!.webContents.session.once('will-download', (_e, item) => item.setSavePath(chosen));
      }, saved);
      await aim('Save the Archive', bundle.getByRole('button', { name: 'Save the Archive' })).click();
      await expect(bundle.locator('[data-evidence="exported"]')).toHaveText(/^Saved a records-only archive of 1 file, /, { timeout: 60_000 });
      await expect.poll(() => page.evaluate((wanted) => (window as unknown as {
        resmonAPI: { getDownloads(): Promise<{ path: string; state: string }[]> };
      }).resmonAPI.getDownloads().then((items) => items.find((item) => item.path === wanted)?.state ?? ''), saved), { timeout: 60_000 }).toBe('completed');
      const read = JSON.parse(execFileSync(env.RESMON_PYTHON ?? 'python3', ['-c', `
import json, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    print(json.dumps({'names': z.namelist(), 'manifest': z.read('manifest.json').decode('utf-8'), 'notes': z.read('notes.md').decode('utf-8')}))
`, saved], { encoding: 'utf8', timeout: 30_000 })) as { names: string[]; manifest: string; notes: string };
      expect(read.names.sort()).toEqual(['manifest.json', 'notes.md']);
      expect(read.manifest).toContain(idOf('unicode.txt').file_id);
      expect(read.manifest + read.notes).toContain(QUOTE);
      for (const left of ['two-pages.pdf', 'image-only.pdf', 'Read both pages']) {
        expect(read.manifest + read.notes, `${left} is in an archive that did not choose it`).not.toContain(left);
      }
    });

    // — the export panel keeps in step with the project -------------------------------------
    // The chosen file taken out while the panel is open: its choice and its
    // bytes go with it, and Save waits for a file that is still here.
    await step('the export panel keeps in step with the project', 120_000, async () => {
      const include = bundle.locator('label.choice', { hasText: 'Include the files themselves' });
      await expect(include).toContainText('recorded');
      await aim('unicode.txt in the project', members.filter({ hasText: 'unicode.txt' })).click();
      await aim('Remove from Project', reader.getByRole('button', { name: 'Remove from Project' })).click();
      await expect(members).toHaveCount(1, { timeout: 30_000 });
      await expect(bundle.locator('label.choice', { hasText: 'unicode.txt' })).toHaveCount(0);
      await expect(bundle.getByRole('button', { name: 'Save the Archive' })).toBeDisabled();
      await expect(include).not.toContainText('recorded');
      // With no file left there is nothing to export, so the panel goes.
      await aim('image-only.pdf in the project', members.filter({ hasText: 'image-only.pdf' })).click();
      await aim('Remove from Project', reader.getByRole('button', { name: 'Remove from Project' })).click();
      await expect(members).toHaveCount(0, { timeout: 30_000 });
      await expect(bundle).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Export Selected Evidence', exact: true })).toBeDisabled();
    });

    expect(problems).toEqual([]);
    say('done');
    passed = true;
  } finally {
    if (!passed) await tellWhere(PREFIX, { app, win, stateDir, watched, wrote, target });
    say('putting away what the test started');
    if (app) await closeWithin(app, PREFIX);
    for (const dir of [stateDir, parent, downloads]) removeStateDir(dir);
  }
});
