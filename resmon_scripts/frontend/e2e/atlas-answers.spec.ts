/**
 * Atlas: Library › Evidence › Answers, in the real app, against an authored
 * model on loopback.
 *
 * A PDF page and a saved passage are chosen with a note; the exact disclosure
 * is shown, and thrown away when the selection changes; Send admits one answer
 * whose citation opens and resolves against the current file; the answer is
 * saved as a ZIP and as one HTML file. Then the three ways an answer does not
 * finish as one: a reply the runtime never marked complete is failed and shown
 * as unvalidated with no citation, Stop cancels a running answer, and leaving
 * the Answers view cancels one too. Each state on screen is held to the
 * engine's record.
 *
 * **The model is authored** (`selectedEvidenceTransport`): the request, the
 * key read from a synthetic keyring, the validation and the saved answer are
 * the app's; whether a real model answers well is not observed. **Scripted:**
 * the folder chooser and the download destinations. J36 and J37 drive the same
 * screen through `journeys/drivers/atlas.ts`; this spec is the part that runs
 * on every pull request. No network beyond loopback.
 *
 * Each step is logged with the time it began (`ANSWERS 17:04:45.120 +3.2 s
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
import { FRONTEND_ROOT, REPO_ROOT, SCREENSHOT_DIR, atlasEnv, launchEnv, registerStateDir, selectedEvidenceTransport } from './fixtures/resmon-app';
import { findCard } from './fixtures/gallery';
import { closeWithin, removeStateDir } from './fixtures/cleanup';
import { capture, stepsWithin, tellWhere, watchWindow, type Target, type Watched } from './fixtures/steps';

const FIXTURES = path.join(REPO_ROOT, 'resmon_scripts', 'verification_scripts', 'fixtures', 'evidence');
const PASSAGE = 'exact passage';
const NOTE = 'ATLAS OWNER NOTE chosen for the answer.';

interface Saved { answer_id: string; state: string; cleanup_state: string; result: unknown; request: { payload: { sources: { text: string }[]; notes: { body: string }[] } } }

async function library<T>(win: Page, route: string, method = 'GET', body?: unknown): Promise<T> {
  return win.evaluate(async ([r, m, b]) => {
    const port = (window as unknown as { resmonAPI: { getBackendPort(): string } }).resmonAPI.getBackendPort();
    const response = await e2eFetch(`http://127.0.0.1:${port}${r}`, {
      method: m as string,
      headers: { 'X-Resmon-Library': '1', ...(b === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(b === undefined ? {} : { body: JSON.stringify(b) }),
    });
    if (!response.ok) throw new Error(`${r} answered HTTP ${response.status}: ${await response.text()}`);
    return response.json();
  }, [route, method, body] as const) as Promise<T>;
}

/**
 * The saved HTML, read the way it is meant to be: in a separate window with
 * resmon closed to it and every request but the file itself refused. It fits
 * a phone's width and a desktop's without scrolling sideways, still fits at
 * twice the zoom, and prints to a PDF that carries the answer.
 */
async function readOffline(file: string, dir: string, env: Record<string, string>, python: string, answerId: string): Promise<void> {
  fs.mkdirSync(dir, { recursive: true });
  const target = `file://${file}`;
  const main = path.join(dir, 'reader.js');
  fs.writeFileSync(main, `const {app,BrowserWindow,session}=require('electron');
const target=${JSON.stringify(target)};
globalThis.reader={blocked:[]};
app.whenReady().then(()=>{
 let first=true;
 session.defaultSession.webRequest.onBeforeRequest({urls:['<all_urls>']},(d,cb)=>{const ok=first&&d.url===target;if(ok)first=false;else globalThis.reader.blocked.push(d.url);cb({cancel:!ok});});
 const win=new BrowserWindow({width:1000,height:850,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});
 win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
 win.loadURL(target);
});
app.on('window-all-closed',()=>app.quit());
`);
  const reader = await electron.launch({ args: [main, `--user-data-dir=${path.join(dir, 'profile')}`], cwd: FRONTEND_ROOT, env, timeout: 180_000 });
  try {
    const page = await reader.firstWindow({ timeout: 60_000 });
    await page.waitForSelector('main');
    const sideways = () => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await sideways(), `the saved answer scrolls sideways at ${width} pixels`).toBe(false);
    }
    await page.setViewportSize({ width: 768, height: 900 });
    await reader.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(2));
    expect(await sideways(), 'the saved answer scrolls sideways at twice the zoom').toBe(false);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-answers-offline-zoom200.png') });
    await reader.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1));
    await page.emulateMedia({ media: 'print' });
    const pdf = path.join(dir, 'answer.pdf');
    fs.writeFileSync(pdf, Buffer.from(await reader.evaluate(async ({ BrowserWindow }) =>
      Array.from(await BrowserWindow.getAllWindows()[0].webContents.printToPDF({ printBackground: true })))));
    expect(fs.readFileSync(pdf).subarray(0, 5).toString()).toBe('%PDF-');
    const printed = execFileSync(python, ['-c',
      "from pypdf import PdfReader;import sys;print('\\n'.join(p.extract_text() or '' for p in PdfReader(sys.argv[1]).pages))", pdf],
    { encoding: 'utf8' });
    // A ligature prints "ff" in a hex id as the one character U+FB00, so the
    // text copied from the printout is not the id; that failed one answer in
    // ten, whenever the random id held "ff". "file_id", "offsets" and
    // "confirmed" are on every printout, so this holds on every run.
    expect(printed.match(/[ﬀ-ﬆ]/gu) ?? [], 'the printout joins letters into ligatures').toEqual([]);
    // A long value may wrap at any character, so the id is looked for with
    // the line breaks taken out.
    expect(printed.replace(/\s+/gu, ''), 'the printed answer does not carry its id').toContain(answerId);
    expect(await reader.evaluate(() => (globalThis as unknown as { reader: { blocked: string[] } }).reader.blocked),
      'the saved answer asked for something besides itself').toEqual([]);
  } finally {
    await reader.close().catch(() => { /* already gone */ });
  }
}

/** Kept back from the test's timeout for saying where a stall stood and for the teardown. */
const TEARDOWN_MS = 60_000;
const PREFIX = 'ANSWERS';

test('Answers: an exact disclosure, one answer per Send, citations that resolve, both exports, and every way an answer stops', async () => {
  test.setTimeout(360_000);
  const { say, step } = stepsWithin(PREFIX, 360_000, TEARDOWN_MS);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-answers-')));
  const stateDir = path.join(root, 'state');
  const parent = path.join(root, 'parent');
  const downloads = path.join(root, 'downloads');
  for (const dir of [stateDir, parent, downloads]) fs.mkdirSync(dir);
  const env = atlasEnv({ ...launchEnv(stateDir, true), PYTHON_KEYRING_BACKEND: 'keyring.backends.null.Keyring' });
  // The fake's scripts need an absolute interpreter for their shebangs.
  const python = execFileSync(env.RESMON_PYTHON ?? 'python3', ['-c', 'import sys;print(sys.executable)'], { env, encoding: 'utf8' }).trim();

  let fake: Awaited<ReturnType<typeof selectedEvidenceTransport>> | null = null;
  let app: ElectronApplication | null = null;
  let win: Page | null = null;
  let watched: Watched | null = null;
  let wrote: (() => string) | null = null;
  // The control the step under way is acting on, for saying where it stood if the step stalls.
  let target: Target | null = null;
  const aim = (name: string, locator: Locator): Locator => { target = { name, locator }; return locator; };
  let passed = false;
  try {
    const model = await selectedEvidenceTransport(root, python);
    fake = model;
    env.RESMON_PYTHON = model.backend;
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
    // The authored model, reached through the custom API connection. The CLI
    // path is the fake's too, so no real agent CLI can start by a misclick.
    await step('the authored model is the one set', 15_000,
      () => library(page, '/api/settings/ai', 'PUT', { settings: { ai_cli_path: model.cli, ai_custom_base_url: model.base } }));

    // — a library, a project, a saved passage and a note ---------------------------------
    await step('the library made, and two files imported', 150_000, async () => {
      await page.evaluate(() => { window.location.hash = '#/library?show=files'; });
      await aim('Choose parent folder', page.getByRole('button', { name: 'Choose parent folder' })).click();
      await aim('Create the library here', page.getByRole('button', { name: 'Create the library here' })).click();
      const importer = page.getByLabel('Import PDF, TXT, MD, or TeX');
      await expect(importer).toBeEnabled({ timeout: 60_000 });
      await importer.setInputFiles(['two-pages.pdf', 'unicode.txt'].map((n) => path.join(FIXTURES, n)));
      await expect(page.locator('[data-library="imported"]')).toHaveText('2 files added. None was already in the Library.', { timeout: 60_000 });
    });
    await step('unicode.txt found on Your files, and read', 60_000,
      async () => aim('Read on unicode.txt', (await findCard(page, 'unicode.txt')).getByRole('button', { name: 'Read' })).click());
    await step('the file\'s page opens Evidence', 60_000,
      () => aim('Open in Evidence', page.getByRole('link', { name: 'Open in Evidence' }).first()).click());
    const { vault, project } = await step('a project, a saved passage, and a note', 150_000, async () => {
      await page.getByLabel('A name for a new project').fill('Atlas answers');
      await aim('Start', page.getByRole('button', { name: 'Start', exact: true })).click();
      await aim('Add unicode.txt to this project', page.getByRole('button', { name: 'Add unicode.txt to this project' })).click();
      const reader = page.getByRole('region', { name: 'Evidence reader' });
      await reader.getByLabel('Find on this page’s text').fill(PASSAGE);
      await aim('Find', reader.getByRole('button', { name: 'Find', exact: true })).click();
      await aim('Use selected passage', reader.getByRole('button', { name: 'Use selected passage' })).click();
      const panel = page.getByRole('region', { name: 'Saved evidence notes' });
      await aim('Save passage', panel.getByRole('button', { name: 'Save passage' })).click();
      await expect(panel.locator('[data-evidence="saved"]')).toBeVisible({ timeout: 30_000 });
      await panel.getByLabel('Note', { exact: true }).fill(NOTE);
      await aim('Save note', panel.getByRole('button', { name: 'Save note' })).click();
      await expect(panel.locator('ol.ev-saved > li')).toHaveCount(2, { timeout: 30_000 });
      await aim('Add files', page.getByRole('button', { name: 'Add files', exact: true })).click();
      await page.getByRole('region', { name: 'Add files from your library' }).locator('label.choice', { hasText: 'two-pages.pdf' }).getByRole('checkbox').check();
      await aim('Add 1 file', page.getByRole('button', { name: 'Add 1 file' })).click();
      await expect(page.getByRole('region', { name: 'Files in this project' }).locator('button.library-file')).toHaveCount(2, { timeout: 30_000 });
      const status = await library<{ vault: { vault_id: string } }>(page, '/api/library');
      const { projects } = await library<{ projects: { project_id: string }[] }>(page, `/api/evidence/projects?expected_vault_id=${status.vault.vault_id}`);
      return { vault: status.vault, project: projects[0]!.project_id };
    });
    const saved = (id: string) => library<Saved>(page, `/api/evidence/projects/${project}/answers/${id}?expected_vault_id=${vault.vault_id}`);
    const settled = async (id: string) => {
      await expect.poll(async () => {
        const a = await saved(id);
        return !['admitted', 'running'].includes(a.state) && a.cleanup_state === 'confirmed';
      }, { timeout: 90_000, message: `answer ${id} never finished with its cleanup confirmed` }).toBe(true);
      return saved(id);
    };

    // — the Answers view, and an exact disclosure ------------------------------------------
    const history = page.getByRole('navigation', { name: 'Saved answers' });
    const article = page.getByRole('article', { name: 'Saved answer' });
    const compose = async () => {
      await aim('New answer', history.getByRole('button', { name: 'New answer' })).click();
      const composer = page.getByRole('region', { name: 'New answer from selected evidence' });
      await expect(composer.getByLabel('Connection', { exact: true })).toBeEnabled({ timeout: 30_000 });
      await composer.getByLabel('Page of two-pages.pdf', { exact: true }).fill('2');
      await aim('Add the page of two-pages.pdf', composer.getByRole('button', { name: 'Add the page of two-pages.pdf' })).click();
      await aim('Add the passage', composer.getByRole('button', { name: `Add the passage “${PASSAGE}”` })).click();
      await composer.getByLabel(`Include note: ${NOTE}`, { exact: true }).check();
      await composer.getByLabel('Question or instruction').fill('What do these excerpts say?');
      await composer.getByLabel('Connection', { exact: true }).selectOption('api_key:custom');
      await composer.getByLabel('Model', { exact: true }).fill('requested-synthetic-model');
      // ⌘Enter (Ctrl+Enter) in the question shows what will be sent, as its button does; it sends nothing.
      await composer.getByLabel('Question or instruction').press('ControlOrMeta+Enter');
      const disclosure = composer.getByRole('region', { name: 'Exact disclosure' });
      await expect(disclosure.getByRole('heading', { name: 'Check before sending' })).toBeVisible({ timeout: 60_000 });
      return { composer, disclosure };
    };
    await step('the Answers view, and an exact disclosure, sent once', 150_000, async () => {
      await aim('Answers', page.getByRole('group', { name: 'In this project' }).getByRole('button', { name: 'Answers' })).click();
      await expect(history.getByText('No answers yet.')).toBeVisible({ timeout: 30_000 });
      const first = await compose();
      const heads = await first.disclosure.locator('article.ev-source h4').allInnerTexts();
      // The engine numbers sources by file id, which is random, so S01 and S02
      // can fall either way round: the numbers and the sources are held apart.
      expect(heads.map((h) => h.replace(/^S0[12] · /, '')).sort())
        .toEqual(['two-pages.pdf · page 2', 'unicode.txt · page 1', 'Your note · revision 1'].sort());
      expect(heads.map((h) => /^(S\d+) · /.exec(h)?.[1]).filter(Boolean).sort()).toEqual(['S01', 'S02']);
      await expect(first.disclosure.locator('article.ev-source pre').filter({ hasText: /^Beta evidence stays separate\.$/ })).toHaveCount(1);
      await expect(first.disclosure.locator('article.ev-source pre').filter({ hasText: new RegExp(`^${PASSAGE}$`) })).toHaveCount(1);
      await expect(first.disclosure).toContainText('a custom API, requested-synthetic-model, effort not supported, at the custom address set in Settings.');
      // Changing what would be sent throws the preview away.
      await first.composer.getByLabel('Answer as').selectOption('briefing');
      await expect(first.disclosure).toHaveCount(0);
      await first.composer.getByLabel('Answer as').selectOption('question');
      await aim('Show exactly what will be sent', first.composer.getByRole('button', { name: 'Show exactly what will be sent' })).click();
      await expect(first.disclosure.getByRole('heading', { name: 'Check before sending' })).toBeVisible({ timeout: 60_000 });
      expect(model.requests, 'a preview called the model').toHaveLength(0);
      await first.disclosure.scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-answers-preview.png') });
      await aim('Send', first.disclosure.getByRole('button', { name: 'Send', exact: true })).click();
    });

    // — one answer, its citation resolved, and its exports ---------------------------------
    const answered = await step('one answer, and its citation resolved', 150_000, async () => {
      await expect(article).toBeVisible({ timeout: 30_000 });
      const done = await settled(String(await article.getAttribute('data-answer')));
      expect(done.state).toBe('succeeded');
      expect(model.requests, 'one Send made more or fewer than one request').toHaveLength(1);
      expect(done.request.payload.notes.map((n) => n.body)).toEqual([NOTE]);
      await expect(article).toHaveAttribute('data-state', 'succeeded', { timeout: 30_000 });
      await expect(article.getByText('Answered', { exact: true })).toBeVisible();
      await expect(article.locator('[data-answer="unvalidated"]')).toHaveCount(0);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-answers.png') });
      const cite = article.locator('button.ev-cite').first();
      await expect(cite).toHaveText(/^S0[12] · (two-pages\.pdf · page 2|unicode\.txt · page 1)$/);
      await aim('the first citation', cite).click();
      const check = article.getByRole('region', { name: 'Saved citation' });
      await expect(check.locator('[data-evidence="resolution"]')).toHaveText(/^Citation matched this exact current text range\./, { timeout: 60_000 });
      expect(await check.getByLabel('Canonical page text').evaluate((el) => {
        const t = el as HTMLTextAreaElement;
        return t.value.slice(t.selectionStart, t.selectionEnd);
      })).toBe((await check.locator('pre.ev-quote').textContent()) ?? '');
      await expect(history.locator(`button.ev-answer-row[data-answer="${done.answer_id}"]`)).toBeVisible();
      await check.scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-answers-citation.png') });
      return done;
    });

    await step('the answer saved as a ZIP and as one HTML file, and the HTML read offline', 240_000, async () => {
      for (const format of ['zip', 'html'] as const) {
        const file = path.join(downloads, `answer.${format}`);
        await launched.evaluate(({ BrowserWindow }, t) => {
          BrowserWindow.getAllWindows()[0]!.webContents.session.once('will-download', (_e, item) => item.setSavePath(t));
        }, file);
        await aim(format === 'zip' ? 'Save as ZIP' : 'Save as HTML', article.getByRole('button', { name: format === 'zip' ? 'Save as ZIP' : 'Save as HTML' })).click();
        await expect(article.locator('[data-answer="saved"]')).toHaveText(
          new RegExp(`^Saved the answer as ${format === 'zip' ? 'a ZIP archive' : 'one HTML file'}`), { timeout: 60_000 });
        await expect.poll(() => fs.existsSync(file) && fs.statSync(file).size > 0, { timeout: 30_000 }).toBe(true);
      }
      const zip = JSON.parse(execFileSync(python, ['-c', `
import json, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    print(json.dumps({'names': sorted(z.namelist()), 'answer': json.loads(z.read('answer.json'))['answer_id']}))
`, path.join(downloads, 'answer.zip')], { encoding: 'utf8', timeout: 30_000 })) as { names: string[]; answer: string };
      expect(zip).toEqual({ names: ['answer.json', 'answer.md', 'evidence.json'], answer: answered.answer_id });
      const html = fs.readFileSync(path.join(downloads, 'answer.html'), 'utf8');
      expect(html.startsWith('<!doctype html>') || html.startsWith('<!DOCTYPE html>')).toBe(true);
      expect(html).toContain(answered.answer_id);
      await readOffline(path.join(downloads, 'answer.html'), path.join(root, 'offline-reader'), env, python, answered.answer_id);
    });

    // — a reply never marked complete: failed, unvalidated, nothing shown as cited ----------
    const failed = await step('a reply never marked complete is failed, and shown unvalidated', 150_000, async () => {
      model.setFault('missing_done');
      const second = await compose();
      await aim('Send', second.disclosure.getByRole('button', { name: 'Send', exact: true })).click();
      await expect(article).not.toHaveAttribute('data-answer', answered.answer_id, { timeout: 30_000 });
      const done = await settled(String(await article.getAttribute('data-answer')));
      expect([done.state, done.result]).toEqual(['failed', null]);
      await expect(article).toHaveAttribute('data-state', 'failed', { timeout: 30_000 });
      await expect(article.locator('[data-answer="unvalidated"]')).toContainText('Nothing here was accepted as an answer');
      await expect(article.locator('button.ev-cite')).toHaveCount(0);
      return done;
    });

    // — Stop, and leaving the view, each cancel a running answer -----------------------------
    const stopping = await step('Stop cancels a running answer', 150_000, async () => {
      model.setFault('hold');
      const third = await compose();
      await aim('Send', third.disclosure.getByRole('button', { name: 'Send', exact: true })).click();
      await expect(article).not.toHaveAttribute('data-answer', failed.answer_id, { timeout: 30_000 });
      const running = String(await article.getAttribute('data-answer'));
      await expect(history.getByRole('button', { name: 'New answer' })).toBeDisabled();
      await aim('Stop the answer', history.getByRole('button', { name: 'Stop the answer' })).click();
      expect((await settled(running)).state).toBe('cancelled');
      await expect(article).toHaveAttribute('data-state', 'cancelled', { timeout: 30_000 });
      await expect(history.getByRole('button', { name: 'New answer' })).toBeEnabled({ timeout: 30_000 });
      return running;
    });

    const leaving = await step('leaving the Answers view cancels a running answer', 150_000, async () => {
      const fourth = await compose();
      await aim('Send', fourth.disclosure.getByRole('button', { name: 'Send', exact: true })).click();
      await expect(article).not.toHaveAttribute('data-answer', stopping, { timeout: 30_000 });
      const running = String(await article.getAttribute('data-answer'));
      await aim('Files and passages', page.getByRole('group', { name: 'In this project' }).getByRole('button', { name: 'Files and passages' })).click();
      expect((await settled(running)).state, 'leaving the Answers view left its answer running').toBe('cancelled');
      return running;
    });

    // — the Claude Code lane, which here is only the fake runtime: discovery is
    // configured-only and the configured command is the fake's ------------------------------
    await step('the Claude Code lane runs the fake runtime once', 150_000, async () => {
      model.setFault('none');
      await aim('Answers', page.getByRole('group', { name: 'In this project' }).getByRole('button', { name: 'Answers' })).click();
      const ran = model.captures().length;
      const apiCalls = model.requests.length;
      const viaCli = await compose();
      const connection = viaCli.composer.getByLabel('Connection', { exact: true });
      const cliKey = await connection.evaluate((select) =>
        [...(select as HTMLSelectElement).options].find((o) => o.value.startsWith('claude_cli:') && !o.disabled)?.value ?? '');
      expect(cliKey, 'the Claude Code connection is not offered, or not available').not.toBe('');
      await connection.selectOption(cliKey);
      await aim('Show exactly what will be sent', viaCli.composer.getByRole('button', { name: 'Show exactly what will be sent' })).click();
      await expect(viaCli.disclosure.getByRole('heading', { name: 'Check before sending' })).toBeVisible({ timeout: 60_000 });
      await aim('Send', viaCli.disclosure.getByRole('button', { name: 'Send', exact: true })).click();
      await expect(article).not.toHaveAttribute('data-answer', leaving, { timeout: 30_000 });
      const cliAnswer = await settled(String(await article.getAttribute('data-answer')));
      expect(cliAnswer.state).toBe('succeeded');
      expect(model.captures().length, 'the Claude Code lane did not run the fake runtime exactly once').toBe(ran + 1);
      expect(model.requests.length, 'the Claude Code lane also called the API').toBe(apiCalls);
      await expect(article).toHaveAttribute('data-state', 'succeeded', { timeout: 30_000 });
      await expect(article.locator('button.ev-cite').first()).toBeVisible();
    });

    expect(problems).toEqual([]);
    say('done');
    passed = true;
  } finally {
    if (!passed) await tellWhere(PREFIX, { app, win, stateDir, watched, wrote, target });
    say('putting away what the test started');
    if (app) await closeWithin(app, PREFIX);
    const model = fake;
    if (model) await Promise.race([model.close(), new Promise((resolve) => setTimeout(resolve, 10_000))]);
    removeStateDir(root);
  }
});
