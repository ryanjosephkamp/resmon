/**
 * Atlas: Ask on Codex, in the real app, on the repository's Codex double.
 *
 * Codex is the second connection in the composer's list. Chosen, the composer
 * asks the command whether it is signed in, says Codex gets resmon's read-only
 * tools only, and lists Codex's own models and effort levels when asked. A
 * turn answers through a tool row, names the model Codex reported and the
 * tokens it reported (never a cost), and the next turn continues the same
 * Codex thread. A write Codex guesses at is refused by resmon's server with no
 * card to answer, and nothing changes. An expired sign-in is a failed turn
 * with Codex's own Sign in, Check again and Try again; a shell command is a
 * turn stopped where it started. Settings › AI makes Codex the connection a
 * new conversation starts with, and Claude Code is never handed the path set
 * for Codex.
 *
 * **No real `codex` is run.** The command is `fake_codex.py` behind a shim in
 * a folder with a space in its name; it starts resmon's MCP server from the
 * overrides it is handed, as Codex does, so the tool calls reach the real
 * server and the real engine. Its sign-in state is a file this spec writes,
 * and the opener records the script it was handed rather than opening
 * Terminal. No network beyond loopback.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test, expect, _electron as electron, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { FRONTEND_ROOT, REPO_ROOT, SCREENSHOT_DIR, launchEnv, registerStateDir } from './fixtures/resmon-app';

async function engine<T>(win: Page, route: string, method = 'GET', body?: unknown): Promise<T> {
  return win.evaluate(async ([r, m, b]) => {
    const port = (window as unknown as { resmonAPI: { getBackendPort(): string } }).resmonAPI.getBackendPort();
    const response = await e2eFetch(`http://127.0.0.1:${port}${r}`, {
      method: m as string,
      headers: b === undefined ? {} : { 'Content-Type': 'application/json' },
      ...(b === undefined ? {} : { body: JSON.stringify(b) }),
    });
    if (!response.ok) throw new Error(`${r} answered HTTP ${response.status}: ${await response.text()}`);
    return response.json();
  }, [route, method, body] as const) as Promise<T>;
}

// 1024 × 768 is the window CI's macOS job runs every spec in.
const SIZES = [
  { width: 1024, height: 768, theme: 'light' },
  { width: 1280, height: 800, theme: 'dark' },
  { width: 1920, height: 1080, theme: 'light' },
] as const;

/** The screen at each size, after animations settle, and nothing wider than the window. */
async function shoot(app: ElectronApplication, win: Page, name: string, subject?: Locator) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  for (const size of SIZES) {
    await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0]?.setContentSize(w, h), [size.width, size.height]);
    await win.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, size.theme);
    await expect.poll(() => win.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(size.width);
    await win.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
    if (subject) await subject.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    const overflow = await win.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `${name} scrolls sideways at ${size.width}`).toBeLessThanOrEqual(1);
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, `${name}-${size.width}-${size.theme}.png`) });
  }
  await win.evaluate(() => { delete document.documentElement.dataset.theme; });
}

test('Ask on Codex: the second connection, read-only tools, a resumed thread, the model and tokens it reports, and its sign-in', async () => {
  test.setTimeout(300_000);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-codex-')));
  const stateDir = path.join(root, 'state');
  const fakeState = path.join(root, 'fake-codex');
  fs.mkdirSync(stateDir);
  fs.mkdirSync(fakeState);
  const auth = (state: string) => fs.writeFileSync(path.join(fakeState, 'auth'), state);
  const lastRun = () => JSON.parse(fs.readFileSync(path.join(fakeState, 'last-run.json'), 'utf8')) as { argv: string[]; tools: string[] | null };
  auth('signed_in');

  const opened = path.join(root, 'opened.txt');
  const opener = path.join(root, 'fake-open');
  fs.writeFileSync(opener, `#!/bin/sh\nprintf "%s\\n" "$@" >> "${opened}"\n`, { mode: 0o755 });

  const env: Record<string, string> = {
    ...launchEnv(stateDir, true), RESMON_UI: 'atlas', FAKE_CODEX_STATE: fakeState, RESMON_SIGN_IN_OPENER: opener,
  };
  const python = execFileSync(env.RESMON_PYTHON ?? 'python3', ['-c', 'import sys;print(sys.executable)'], { env, encoding: 'utf8' }).trim();
  const tools = path.join(root, 'Codex Tools');
  fs.mkdirSync(tools);
  const cli = path.join(tools, 'codex');
  fs.writeFileSync(cli, `#!/bin/sh\nexec "${python}" "${path.join(REPO_ROOT, 'resmon_scripts/verification_scripts/fixtures/fake_codex.py')}" "$@"\n`, { mode: 0o755 });

  const app = await electron.launch({
    args: ['.', `--user-data-dir=${path.join(stateDir, 'electron-user-data')}`],
    cwd: FRONTEND_ROOT, env, colorScheme: null, timeout: 180_000,
  });
  registerStateDir(stateDir);
  try {
    const win = await app.firstWindow({ timeout: 180_000 });
    const problems: string[] = [];
    win.on('pageerror', (e) => problems.push(e.message));
    await expect(win.getByRole('navigation', { name: 'Sections' })).toBeVisible({ timeout: 120_000 });
    // The path is Codex's because summaries use Codex: that is the one setting both read.
    await engine(win, '/api/settings/ai', 'PUT', { settings: { ai_provider: 'codex', ai_cli_path: cli } });

    await win.evaluate(() => { window.location.hash = '#/ask'; });
    const pane = win.getByRole('region', { name: 'Conversation' });
    const composer = pane.getByLabel('Message the assistant');
    const connection = pane.getByLabel('Connection', { exact: true });
    await expect(pane.getByRole('heading', { name: 'New conversation' })).toBeVisible({ timeout: 30_000 });

    // — Codex is the second connection, and choosing it says what it is given --------------
    // The status read on arrival may predate the path set above; the composer reads it again.
    await expect(connection.locator('option').nth(2)).toHaveText('Codex', { timeout: 30_000 });
    await expect(connection.locator('option').nth(1)).toHaveText(/^Claude Code/);
    await connection.selectOption('codex_cli:codex');
    const signIn = pane.locator('.conv-compose [data-ai="sign-in"]');
    await expect(signIn).toHaveAttribute('aria-label', 'Codex sign-in');
    await expect(signIn).toHaveAttribute('data-state', 'signed_in', { timeout: 30_000 });
    await expect(signIn).toContainText('The Codex command is signed in, with ChatGPT.');
    await expect(pane.locator('[data-ask="connection-reason"]')).toContainText('read-only tools only');
    await expect(pane.locator('[data-ask="model-words"]')).toHaveText('Model: The command’s default.');

    // — Codex's own models, and each one's effort levels, when asked ----------------------
    const effort = pane.getByLabel('Effort', { exact: true });
    expect(await effort.locator('option').allTextContents()).toEqual(['The CLI’s default']);
    await pane.getByRole('button', { name: 'Load models' }).click();
    await expect(pane.locator('[data-ask="model-list"]')).toHaveAttribute('data-count', '2', { timeout: 30_000 });
    await expect(pane.locator('[data-ask="model-list"]')).toContainText('Reported by `codex debug models` on this machine.');
    expect(await pane.locator('#conv-codex-models option').evaluateAll((o) => o.map((x) => (x as HTMLOptionElement).value)))
      .toEqual(['gpt-5.5-codex', 'gpt-5.5-mini']);
    await pane.getByLabel('Model', { exact: true }).fill('gpt-5.5-codex');
    expect(await effort.locator('option').allTextContents()).toEqual(['The CLI’s default', 'minimal', 'low', 'medium', 'high']);
    await effort.selectOption('high');
    await shoot(app, win, 'atlas-ask-codex-choices');

    // — a read, through resmon's read-only server -------------------------------------------
    await composer.fill('MODEL:gpt-5.5-codex\nSAY:Your sources are listed below.\nCALL:list_sources {}');
    await pane.getByRole('button', { name: 'Send', exact: true }).click();
    const answers = pane.locator('.conv-msg[data-role="assistant"]');
    await expect(answers).toHaveCount(1, { timeout: 60_000 });
    await expect(pane.locator('.conv-working')).toHaveCount(0, { timeout: 30_000 });
    await expect(answers.first().locator('.conv-text')).toHaveText('Your sources are listed below.');
    await expect(answers.first().locator('.conv-call-name')).toHaveText('list_sources');
    await expect(answers.first().locator('.conv-cost')).toHaveText('GPT-5.5-Codex · high effort · 1,200 tokens in, 80 out, as Codex reported');
    await expect(pane.getByText(/Reported cost|Cost not reported/)).toHaveCount(0);
    await expect(pane.locator('.conv-fixed')).toContainText('Codex · gpt-5.5-codex (answered by GPT-5.5-Codex) · effort high');
    const first = lastRun();
    expect(first.argv.slice(0, 1)).toEqual(['exec']);
    expect(first.argv).toContain('--ignore-user-config');
    expect([...(first.tools ?? [])].sort()).not.toContain('create_routine');
    expect(first.tools ?? []).toContain('list_sources');

    // — the next turn continues the same Codex thread ---------------------------------------
    const [session] = (await engine<{ sessions: { id: number }[] }>(win, '/api/assistant/sessions')).sessions;
    const stored = await engine<{ session: { cli_session_id: string; runtime: string } }>(win, `/api/assistant/sessions/${session!.id}`);
    expect(stored.session.runtime).toBe('codex_cli');
    await composer.fill('SAY:And nothing has changed since.');
    await pane.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(answers).toHaveCount(2, { timeout: 60_000 });
    await expect(pane.locator('.conv-working')).toHaveCount(0, { timeout: 30_000 });
    const second = lastRun();
    expect(second.argv.slice(0, 2)).toEqual(['exec', 'resume']);
    expect(second.argv[second.argv.length - 2]).toBe(stored.session.cli_session_id);

    // — a write Codex guesses at is refused by the server, with no card, and nothing changes -
    const before = (await engine<{ name: string }[]>(win, '/api/routines')).map((r) => r.name);
    await composer.fill('CALL:create_routine {"name": "Codex watch", "schedule": "0 7 * * 1", "sources": ["arxiv"], "keywords": ["perovskite"]}\nSAY:That needs Claude Code.');
    await pane.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(answers).toHaveCount(3, { timeout: 60_000 });
    await expect(pane.locator('.conv-working')).toHaveCount(0, { timeout: 30_000 });
    await expect(pane.locator('.conv-card')).toHaveCount(0);
    expect((await engine<{ name: string }[]>(win, '/api/routines')).map((r) => r.name)).toEqual(before);
    await shoot(app, win, 'atlas-ask-codex-answered');

    // — an expired sign-in is a failed turn, with Codex's own way back ----------------------
    auth('expired');
    await composer.fill('SAY:not said');
    await pane.getByRole('button', { name: 'Send', exact: true }).click();
    const failed = pane.locator('.conv-failed');
    await expect(failed).toHaveCount(1, { timeout: 60_000 });
    await expect(pane.locator('.conv-working')).toHaveCount(0, { timeout: 30_000 });
    await expect(failed).toHaveAttribute('data-code', 'cli_auth');
    await expect(failed).toContainText('The Codex command on this computer is not signed in, or its sign-in expired');
    await expect(failed.locator('.conv-failed-message')).toHaveText(
      'The Codex command on this computer is not signed in, or its sign-in expired, so it could not answer. '
      + 'It said: unexpected status 401 Unauthorized: Your access token could not be refreshed. Please log in again.');
    const failedSignIn = failed.locator('[data-ai="sign-in"]');
    await expect(failedSignIn).toHaveAttribute('aria-label', 'Codex sign-in');
    await failedSignIn.getByRole('button', { name: 'Check again' }).click();
    await expect(failedSignIn).toHaveAttribute('data-state', 'expired', { timeout: 30_000 });
    await failedSignIn.getByRole('button', { name: 'Sign in' }).click();
    if (process.platform === 'darwin') {
      await expect(failedSignIn.locator('[data-ai="sign-in-opened"]')).toContainText('Terminal is running Codex’s own sign-in.', { timeout: 30_000 });
      const script = fs.readFileSync(opened, 'utf8').trim().split('\n').pop() as string;
      expect(fs.readFileSync(script, 'utf8')).toContain(`\n'${cli}' login\n`);
      // What Terminal would have done: the command's own login.
      execFileSync('/bin/sh', [script], { env: { ...env, TERM: 'dumb' }, encoding: 'utf8' });
    } else {
      await expect(failedSignIn.locator('[data-ai="sign-in-command"] code')).toHaveText(`'${cli}' login`, { timeout: 30_000 });
      execFileSync(cli, ['login'], { env: { ...env, TERM: 'dumb' }, encoding: 'utf8' });
    }
    await failedSignIn.getByRole('button', { name: 'Check again' }).click();
    await expect(failedSignIn).toHaveAttribute('data-state', 'signed_in', { timeout: 30_000 });
    await shoot(app, win, 'atlas-ask-codex-failed-turn', failed);
    await failed.getByRole('button', { name: 'Try again' }).click();
    await expect(answers).toHaveCount(4, { timeout: 60_000 });
    await expect(pane.locator('.conv-working')).toHaveCount(0, { timeout: 30_000 });
    await expect(answers.last().locator('.conv-text')).toHaveText('not said');

    // — a shell command is a turn stopped where it started -----------------------------------
    const started = Date.now();
    await composer.fill('SAY:Let me look.\nSHELL:ls ~');
    await pane.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(failed).toHaveCount(2, { timeout: 60_000 });
    await expect(pane.locator('.conv-working')).toHaveCount(0, { timeout: 30_000 });
    expect(Date.now() - started, 'the double was left to run out its minute').toBeLessThan(30_000);
    const stopped = failed.last();
    await expect(stopped).toHaveAttribute('data-code', 'failed');
    await expect(stopped).toContainText('Codex started a shell command, which Ask does not allow, so resmon stopped the turn.');
    await stopped.getByText('What it wrote before it ended').click();
    await expect(stopped.locator('.conv-call-name')).toHaveText('shell');
    await shoot(app, win, 'atlas-ask-codex-stopped', stopped);

    // — Settings › AI makes Codex what a new conversation starts with; Claude Code is not handed Codex's path -
    await win.evaluate(() => { window.location.hash = '#/settings/ai'; });
    const form = win.getByRole('form', { name: 'Assistant settings' });
    await expect(form).toBeVisible({ timeout: 30_000 });
    const routes = win.locator('[data-ai="routes"]');
    // The one path set is Codex's, so Claude Code is looked for on its own, and not found here.
    await expect(routes.locator('li[data-kind="claude_cli"]')).toHaveAttribute('data-available', 'false');
    await expect(routes.locator('li[data-kind="codex_cli"]')).toHaveAttribute('data-available', 'true');
    expect(await form.locator('#assistant-runtime option').allTextContents())
      .toEqual(['Claude Code, the claude command', 'Codex, the codex command', 'An API key']);
    await form.locator('#assistant-runtime').selectOption('codex_cli');
    await form.getByRole('button', { name: 'Load models' }).click();
    await expect(form.locator('[data-ai="model-list"]')).toHaveAttribute('data-count', '2', { timeout: 30_000 });
    await form.locator('#assistant-model').selectOption('gpt-5.5-codex');
    expect(await form.locator('#assistant-effort option').allTextContents())
      .toEqual(['The command’s default', 'minimal', 'low', 'medium', 'high']);
    await form.locator('#assistant-effort').selectOption('medium');
    await expect(form.locator('[data-ai="codex-default"]')).toContainText('read-only tools only');
    await form.getByRole('button', { name: 'Save assistant settings' }).click();
    await expect(form.getByRole('status')).toHaveText(/^Saved\./, { timeout: 30_000 });
    expect(await engine<Record<string, string>>(win, '/api/settings/assistant')).toMatchObject({
      assistant_runtime: 'codex_cli', assistant_model: 'gpt-5.5-codex', assistant_effort: 'medium' });
    await expect(routes.locator('li').first()).toHaveAttribute('data-kind', 'codex_cli');
    await expect(win.locator('section[aria-labelledby="ai-assistant"] [data-ai="sign-in"]')).toHaveAttribute('aria-label', 'Codex sign-in');
    await shoot(app, win, 'atlas-ask-codex-default', form);
    await win.evaluate(() => { window.location.hash = '#/ask'; });
    await win.getByRole('region', { name: 'Saved chats' }).getByRole('button', { name: 'New conversation' }).click();
    await expect(pane.getByRole('heading', { name: 'New conversation' })).toBeVisible({ timeout: 30_000 });
    await expect(connection).toHaveValue('codex_cli:codex');
    await expect(pane.getByLabel('Model', { exact: true })).toHaveValue('gpt-5.5-codex');
    await expect(pane.getByLabel('Effort', { exact: true })).toHaveValue('medium');

    expect(problems, 'the renderer threw').toEqual([]);
  } finally {
    await app.close().catch(() => {});
  }
});
