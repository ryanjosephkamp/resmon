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
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { FRONTEND_ROOT, REPO_ROOT, SCREENSHOT_DIR, launchEnv, registerStateDir, selectedEvidenceTransport } from './fixtures/resmon-app';

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

test('Answers: an exact disclosure, one answer per Send, citations that resolve, both exports, and every way an answer stops', async () => {
  test.setTimeout(360_000);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-answers-')));
  const stateDir = path.join(root, 'state');
  const parent = path.join(root, 'parent');
  const downloads = path.join(root, 'downloads');
  for (const dir of [stateDir, parent, downloads]) fs.mkdirSync(dir);
  const env: Record<string, string> = { ...launchEnv(stateDir, true), RESMON_UI: 'atlas', PYTHON_KEYRING_BACKEND: 'keyring.backends.null.Keyring' };
  // The fake's scripts need an absolute interpreter for their shebangs.
  const python = execFileSync(env.RESMON_PYTHON ?? 'python3', ['-c', 'import sys;print(sys.executable)'], { env, encoding: 'utf8' }).trim();
  const fake = await selectedEvidenceTransport(root, python);
  env.RESMON_PYTHON = fake.backend;

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
    // The authored model, reached through the custom API connection. The CLI
    // path is the fake's too, so no real agent CLI can start by a misclick.
    await library(win, '/api/settings/ai', 'PUT', { settings: { ai_cli_path: fake.cli, ai_custom_base_url: fake.base } });

    // — a library, a project, a saved passage and a note ---------------------------------
    await win.evaluate(() => { window.location.hash = '#/library/files'; });
    await win.getByRole('button', { name: 'Choose parent folder' }).click();
    await win.getByRole('button', { name: 'Create the library here' }).click();
    const importer = win.getByLabel('Import PDF, TXT or MD');
    await expect(importer).toBeEnabled({ timeout: 60_000 });
    await importer.setInputFiles(['two-pages.pdf', 'unicode.txt'].map((n) => path.join(FIXTURES, n)));
    await expect(win.locator('[data-library="imported"]')).toHaveText('2 retained, 0 exact duplicates reused.', { timeout: 60_000 });
    await win.locator('button.library-file', { hasText: 'unicode.txt' }).click();
    await win.getByRole('link', { name: 'Open in Evidence' }).click();
    await win.getByLabel('A name for a new project').fill('Atlas answers');
    await win.getByRole('button', { name: 'Start', exact: true }).click();
    await win.getByRole('button', { name: 'Add unicode.txt to this project' }).click();
    const reader = win.getByRole('region', { name: 'Evidence reader' });
    await reader.getByLabel('Find on this page’s text').fill(PASSAGE);
    await reader.getByRole('button', { name: 'Find', exact: true }).click();
    await reader.getByRole('button', { name: 'Use selected passage' }).click();
    const panel = win.getByRole('region', { name: 'Saved evidence notes' });
    await panel.getByRole('button', { name: 'Save passage' }).click();
    await expect(panel.locator('[data-evidence="saved"]')).toBeVisible({ timeout: 30_000 });
    await panel.getByLabel('Note', { exact: true }).fill(NOTE);
    await panel.getByRole('button', { name: 'Save note' }).click();
    await expect(panel.locator('ol.ev-saved > li')).toHaveCount(2, { timeout: 30_000 });
    await win.getByRole('button', { name: 'Add files', exact: true }).click();
    await win.getByRole('region', { name: 'Add files from your library' }).locator('label.choice', { hasText: 'two-pages.pdf' }).getByRole('checkbox').check();
    await win.getByRole('button', { name: 'Add 1 file' }).click();
    await expect(win.getByRole('region', { name: 'Files in this project' }).locator('button.library-file')).toHaveCount(2, { timeout: 30_000 });
    const { vault } = await library<{ vault: { vault_id: string } }>(win, '/api/library');
    const { projects } = await library<{ projects: { project_id: string }[] }>(win, `/api/evidence/projects?expected_vault_id=${vault.vault_id}`);
    const project = projects[0]!.project_id;
    const saved = (id: string) => library<Saved>(win, `/api/evidence/projects/${project}/answers/${id}?expected_vault_id=${vault.vault_id}`);
    const settled = async (id: string) => {
      await expect.poll(async () => {
        const a = await saved(id);
        return !['admitted', 'running'].includes(a.state) && a.cleanup_state === 'confirmed';
      }, { timeout: 90_000, message: `answer ${id} never finished with its cleanup confirmed` }).toBe(true);
      return saved(id);
    };

    // — the Answers view, and an exact disclosure ------------------------------------------
    await win.getByRole('group', { name: 'In this project' }).getByRole('button', { name: 'Answers' }).click();
    const history = win.getByRole('navigation', { name: 'Saved answers' });
    await expect(history.getByText('No answers yet.')).toBeVisible({ timeout: 30_000 });
    const compose = async () => {
      await history.getByRole('button', { name: 'New answer' }).click();
      const composer = win.getByRole('region', { name: 'New answer from selected evidence' });
      await expect(composer.getByLabel('Connection', { exact: true })).toBeEnabled({ timeout: 30_000 });
      await composer.getByLabel('Page of two-pages.pdf', { exact: true }).fill('2');
      await composer.getByRole('button', { name: 'Add the page of two-pages.pdf' }).click();
      await composer.getByRole('button', { name: `Add the passage “${PASSAGE}”` }).click();
      await composer.getByLabel(`Include note: ${NOTE}`, { exact: true }).check();
      await composer.getByLabel('Question or instruction').fill('What do these excerpts say?');
      await composer.getByLabel('Connection', { exact: true }).selectOption('api_key:custom');
      await composer.getByLabel('Model', { exact: true }).fill('requested-synthetic-model');
      await composer.getByRole('button', { name: 'Show exactly what will be sent' }).click();
      const disclosure = composer.getByRole('region', { name: 'Exact disclosure' });
      await expect(disclosure.getByRole('heading', { name: 'Check before sending' })).toBeVisible({ timeout: 60_000 });
      return { composer, disclosure };
    };
    const first = await compose();
    const heads = await first.disclosure.locator('article.ev-source h4').allInnerTexts();
    expect(heads.sort()).toEqual(['S01 · two-pages.pdf · page 2', 'S02 · unicode.txt · page 1', 'Your note · revision 1'].sort());
    await expect(first.disclosure.locator('article.ev-source pre').filter({ hasText: /^Beta evidence stays separate\.$/ })).toHaveCount(1);
    await expect(first.disclosure.locator('article.ev-source pre').filter({ hasText: new RegExp(`^${PASSAGE}$`) })).toHaveCount(1);
    await expect(first.disclosure).toContainText('a custom API, requested-synthetic-model, effort not supported, at the custom address set in Settings.');
    // Changing what would be sent throws the preview away.
    await first.composer.getByLabel('Answer as').selectOption('briefing');
    await expect(first.disclosure).toHaveCount(0);
    await first.composer.getByLabel('Answer as').selectOption('question');
    await first.composer.getByRole('button', { name: 'Show exactly what will be sent' }).click();
    await expect(first.disclosure.getByRole('heading', { name: 'Check before sending' })).toBeVisible({ timeout: 60_000 });
    expect(fake.requests, 'a preview called the model').toHaveLength(0);
    await first.disclosure.scrollIntoViewIfNeeded();
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-answers-preview.png') });
    await first.disclosure.getByRole('button', { name: 'Send', exact: true }).click();

    // — one answer, its citation resolved, and its exports ---------------------------------
    const article = win.getByRole('article', { name: 'Saved answer' });
    await expect(article).toBeVisible({ timeout: 30_000 });
    const answered = await settled(String(await article.getAttribute('data-answer')));
    expect(answered.state).toBe('succeeded');
    expect(fake.requests, 'one Send made more or fewer than one request').toHaveLength(1);
    expect(answered.request.payload.notes.map((n) => n.body)).toEqual([NOTE]);
    await expect(article).toHaveAttribute('data-state', 'succeeded', { timeout: 30_000 });
    await expect(article.getByText('Answered', { exact: true })).toBeVisible();
    await expect(article.locator('[data-answer="unvalidated"]')).toHaveCount(0);
    await win.evaluate(() => window.scrollTo(0, 0));
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-answers.png') });
    const cite = article.locator('button.ev-cite').first();
    await expect(cite).toHaveText(/^S0[12] · (two-pages\.pdf · page 2|unicode\.txt · page 1)$/);
    await cite.click();
    const check = article.getByRole('region', { name: 'Saved citation' });
    await expect(check.locator('[data-evidence="resolution"]')).toHaveText(/^Citation matched this exact current text range\./, { timeout: 60_000 });
    expect(await check.getByLabel('Canonical page text').evaluate((el) => {
      const t = el as HTMLTextAreaElement;
      return t.value.slice(t.selectionStart, t.selectionEnd);
    })).toBe((await check.locator('pre.ev-quote').textContent()) ?? '');
    await expect(history.locator(`button.ev-answer-row[data-answer="${answered.answer_id}"]`)).toBeVisible();
    await check.scrollIntoViewIfNeeded();
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-answers-citation.png') });

    for (const format of ['zip', 'html'] as const) {
      const target = path.join(downloads, `answer.${format}`);
      await app.evaluate(({ BrowserWindow }, t) => {
        BrowserWindow.getAllWindows()[0]!.webContents.session.once('will-download', (_e, item) => item.setSavePath(t));
      }, target);
      await article.getByRole('button', { name: format === 'zip' ? 'Save as ZIP' : 'Save as HTML' }).click();
      await expect(article.locator('[data-answer="saved"]')).toHaveText(
        new RegExp(`^Saved the answer as ${format === 'zip' ? 'a ZIP archive' : 'one HTML file'}`), { timeout: 60_000 });
      await expect.poll(() => fs.existsSync(target) && fs.statSync(target).size > 0, { timeout: 30_000 }).toBe(true);
    }
    const zip = JSON.parse(execFileSync(python, ['-c', `
import json, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    print(json.dumps({'names': sorted(z.namelist()), 'answer': json.loads(z.read('answer.json'))['answer_id']}))
`, path.join(downloads, 'answer.zip')], { encoding: 'utf8' })) as { names: string[]; answer: string };
    expect(zip).toEqual({ names: ['answer.json', 'answer.md', 'evidence.json'], answer: answered.answer_id });
    const html = fs.readFileSync(path.join(downloads, 'answer.html'), 'utf8');
    expect(html.startsWith('<!doctype html>') || html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain(answered.answer_id);

    // — a reply never marked complete: failed, unvalidated, nothing shown as cited ----------
    fake.setFault('missing_done');
    const second = await compose();
    await second.disclosure.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(article).not.toHaveAttribute('data-answer', answered.answer_id, { timeout: 30_000 });
    const failed = await settled(String(await article.getAttribute('data-answer')));
    expect([failed.state, failed.result]).toEqual(['failed', null]);
    await expect(article).toHaveAttribute('data-state', 'failed', { timeout: 30_000 });
    await expect(article.locator('[data-answer="unvalidated"]')).toContainText('Nothing here was accepted as an answer');
    await expect(article.locator('button.ev-cite')).toHaveCount(0);

    // — Stop, and leaving the view, each cancel a running answer -----------------------------
    fake.setFault('hold');
    const third = await compose();
    await third.disclosure.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(article).not.toHaveAttribute('data-answer', failed.answer_id, { timeout: 30_000 });
    const stopping = String(await article.getAttribute('data-answer'));
    await expect(history.getByRole('button', { name: 'New answer' })).toBeDisabled();
    await history.getByRole('button', { name: 'Stop the answer' }).click();
    expect((await settled(stopping)).state).toBe('cancelled');
    await expect(article).toHaveAttribute('data-state', 'cancelled', { timeout: 30_000 });
    await expect(history.getByRole('button', { name: 'New answer' })).toBeEnabled({ timeout: 30_000 });

    const fourth = await compose();
    await fourth.disclosure.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(article).not.toHaveAttribute('data-answer', stopping, { timeout: 30_000 });
    const leaving = String(await article.getAttribute('data-answer'));
    await win.getByRole('group', { name: 'In this project' }).getByRole('button', { name: 'Files and passages' }).click();
    expect((await settled(leaving)).state, 'leaving the Answers view left its answer running').toBe('cancelled');

    expect(problems).toEqual([]);
  } finally {
    await app.close();
    await fake.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
