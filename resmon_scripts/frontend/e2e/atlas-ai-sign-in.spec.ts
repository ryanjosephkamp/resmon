/**
 * Atlas: Claude Code's sign-in and the model each answer reports, in the real app.
 *
 * Settings › AI asks the command whether it is signed in when it is opened,
 * and again on Check again; Sign in opens the command's own login through the
 * `.command` script the engine writes. An Ask turn the command refuses for an
 * expired sign-in is kept as a failed turn under the message (no assistant
 * message, no cost line), with Sign in, Check again and Try again right there;
 * the retried answer names the model it came from, the conversation's header
 * says so, and the next conversation's model choice remembers it. A run whose
 * summary lane met the same refusal offers the sign-in on its page, and one
 * whose lane answered says which model wrote its summaries.
 *
 * **No real `claude` is run.** The command is `fake_claude.py` behind a shim
 * in a folder with a space in its name; its sign-in state is a file this spec
 * writes. The opener is a script that records the path it was handed, so no
 * Terminal window opens; the spec then runs that script itself, as Terminal
 * would, against the fake. The two runs on the Run page are written into the
 * database rather than run.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
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

/** Two settled runs, one whose summary lane met an expired sign-in and one whose lane answered. */
const SEED_RUNS = String.raw`
import json, os, sqlite3, sys
sys.path.insert(0, sys.argv[1])
from implementation_scripts import database as db
conn = sqlite3.connect(os.environ["RESMON_DB_PATH"])
conn.row_factory = sqlite3.Row
conn.execute("PRAGMA foreign_keys=ON")
ids = []
for lane in ("refused", "answered"):
    rid = db.insert_execution(conn, {"execution_type": "deep_dive", "start_time": "2026-10-30T15:40:00",
        "parameters": json.dumps({"query": "perovskite stability", "repositories": ["arxiv"], "ai_enabled": True}),
        "status": "running"})
    conn.execute("UPDATE executions SET status='completed', end_time='2026-10-30T15:41:00' WHERE id=?", (rid,))
    conn.commit()
    db.start_ai_lane(conn, rid, 0, lane_label="Claude Code · haiku", lane_kind="subscription",
                     provider="claude_code", model="haiku")
    if lane == "refused":
        db.finish_ai_lane(conn, rid, 0, outcome="failed", docs_attempted=2, docs_succeeded=0, error_kind="cli_auth",
            safe_message="The Claude Code command on this computer is not signed in, or its sign-in expired. "
                         "It said: Failed to authenticate: OAuth session expired and could not be refreshed")
    else:
        db.finish_ai_lane(conn, rid, 0, outcome="ok", docs_attempted=2, docs_succeeded=2)
        db.record_ai_lane_models(conn, rid, 0, [("claude-haiku-4-5-20251001", 1)])
    ids.append(rid)
print(json.dumps(ids))
`;

const SIZES = [{ width: 1280, height: 800, theme: 'light' }, { width: 1920, height: 1080, theme: 'dark' }] as const;

/** The same screen at 1280 in light and 1920 in dark, after animations settle. */
async function shoot(app: ElectronApplication, win: Page, name: string) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  for (const size of SIZES) {
    await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0]?.setContentSize(w, h), [size.width, size.height]);
    await win.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, size.theme);
    await expect.poll(() => win.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(size.width);
    await win.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, `${name}-${size.width}-${size.theme}.png`) });
  }
}

test('Claude Code sign-in: checked in Settings › AI, offered where a turn fails, and the model each answer reports', async () => {
  test.setTimeout(300_000);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-sign-in-')));
  const stateDir = path.join(root, 'state');
  const fakeState = path.join(root, 'fake-claude');
  fs.mkdirSync(stateDir);
  fs.mkdirSync(fakeState);
  const auth = (state: string) => fs.writeFileSync(path.join(fakeState, 'auth'), state);
  auth('signed_in');

  const opened = path.join(root, 'opened.txt');
  const opener = path.join(root, 'fake-open');
  fs.writeFileSync(opener, `#!/bin/sh\nprintf "%s\\n" "$@" >> "${opened}"\n`, { mode: 0o755 });

  const env: Record<string, string> = {
    ...launchEnv(stateDir, true), RESMON_UI: 'atlas', FAKE_CLAUDE_STATE: fakeState, RESMON_SIGN_IN_OPENER: opener,
  };
  const python = execFileSync(env.RESMON_PYTHON ?? 'python3', ['-c', 'import sys;print(sys.executable)'], { env, encoding: 'utf8' }).trim();
  // In a folder with a space in its name, so the script's quoting is what is exercised.
  const tools = path.join(root, 'Claude Tools');
  fs.mkdirSync(tools);
  const cli = path.join(tools, 'claude');
  fs.writeFileSync(cli, `#!/bin/sh\nexec "${python}" "${path.join(REPO_ROOT, 'resmon_scripts/verification_scripts/fixtures/fake_claude.py')}" "$@"\n`, { mode: 0o755 });

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
    await engine(win, '/api/settings/ai', 'PUT', { settings: { ai_provider: 'claude_code', ai_model: 'haiku', ai_cli_path: cli } });
    await engine(win, '/api/settings/assistant', 'PUT', { settings: {
      assistant_runtime: 'claude_cli', assistant_model: 'haiku', assistant_effort: 'high' } });

    // — Settings › AI asks the command, once, when it is opened ---------------------------
    await win.evaluate(() => { window.location.hash = '#/settings/ai'; });
    const summaries = win.locator('[aria-labelledby="ai-summaries"] [data-ai="sign-in"]');
    const assistant = win.locator('[aria-labelledby="ai-assistant"] [data-ai="sign-in"]');
    await expect(summaries).toHaveAttribute('data-state', 'signed_in', { timeout: 30_000 });
    await expect(summaries).toContainText('The Claude Code command is signed in as reader@example.com (max).');
    await expect(assistant).toHaveAttribute('data-state', 'signed_in', { timeout: 30_000 });
    await expect(summaries.getByRole('button', { name: 'Sign in' })).toHaveCount(0);

    // — the sign-in expires; Check again says so, and Sign in opens the command's login ---
    auth('expired');
    await summaries.getByRole('button', { name: 'Check again' }).click();
    await expect(summaries).toHaveAttribute('data-state', 'expired', { timeout: 30_000 });
    await expect(summaries).toContainText('The Claude Code command’s sign-in has expired. Sign in again through it.');
    await expect(summaries).toContainText('resmon does not see or keep the sign-in: the command keeps it.');
    await summaries.getByRole('button', { name: 'Sign in' }).click();
    if (process.platform === 'darwin') {
      await expect(summaries.locator('[data-ai="sign-in-opened"]')).toContainText('Terminal is running Claude Code’s own sign-in.', { timeout: 30_000 });
      const script = fs.readFileSync(opened, 'utf8').trim().split('\n').pop() as string;
      expect(path.dirname(script)).toBe(path.join(stateDir, 'sign-in'));
      expect(fs.readFileSync(script, 'utf8')).toContain(`\n'${cli}' auth login\n`);
      await win.locator('[aria-labelledby="ai-summaries"]').scrollIntoViewIfNeeded();
      await shoot(app, win, 'atlas-ai-sign-in-settings');
      // What Terminal would have done: the command's own login, then back here.
      const ran = execFileSync('/bin/sh', [script], { env: { ...env, TERM: 'dumb' }, encoding: 'utf8' });
      expect(ran).toContain('Done. Return to resmon and choose Check again.');
    } else {
      // Off macOS no terminal is opened: the command is shown to copy, and
      // running it is what the person would do in their own terminal.
      const shown = summaries.locator('[data-ai="sign-in-command"]');
      await expect(shown).toContainText('Run this in a terminal to sign in to Claude Code with its own login', { timeout: 30_000 });
      await expect(shown.locator('code')).toHaveText(`'${cli}' auth login`);
      execFileSync(cli, ['auth', 'login'], { env: { ...env, TERM: 'dumb' }, encoding: 'utf8' });
    }
    await summaries.getByRole('button', { name: 'Check again' }).click();
    await expect(summaries).toHaveAttribute('data-state', 'signed_in', { timeout: 30_000 });

    // — Ask: a turn the command refuses is a failed turn, not an answer -------------------
    auth('expired');
    await win.evaluate(() => { window.location.hash = '#/ask'; });
    const pane = win.getByRole('region', { name: 'Conversation' });
    const composer = pane.getByLabel('Message the assistant');
    await expect(pane.getByRole('heading', { name: 'New conversation' })).toBeVisible({ timeout: 30_000 });
    const composing = pane.locator('.conv-compose [data-ai="sign-in"]');
    await expect(composing).toHaveAttribute('data-state', 'expired', { timeout: 30_000 });
    await expect(pane.locator('[data-ask="model-words"]')).toHaveText('Model: haiku: the newest Haiku.');
    await expect(composer).toBeEnabled({ timeout: 30_000 });
    await composer.fill('USAGE:claude-haiku-5-5\nSAY:Your most recent search was on perovskite stability.');
    await pane.getByRole('button', { name: 'Send', exact: true }).click();
    const failed = pane.locator('.conv-failed');
    await expect(failed).toBeVisible({ timeout: 60_000 });
    await expect(pane.locator('.conv-working')).toHaveCount(0, { timeout: 30_000 });
    await expect(failed).toHaveAttribute('data-code', 'cli_auth');
    await expect(failed).toContainText('No answer');
    await expect(failed).toContainText('The Claude Code command on this computer is not signed in, or its sign-in expired');
    await expect(failed.getByRole('button', { name: 'Sign in' })).toBeVisible();
    await expect(failed.getByRole('button', { name: 'Check again' })).toBeVisible();
    await expect(failed.getByRole('button', { name: 'Try again' })).toBeVisible();
    await expect(pane.locator('.conv-msg[data-role="assistant"]')).toHaveCount(0);
    await expect(pane.getByText(/Reported cost/)).toHaveCount(0);
    await expect(pane.locator('.conv-saved')).toContainText('1 saved message ');
    // Said once, under the message, and not again above the composer.
    await expect(pane.locator('.conv-error')).toHaveCount(0);
    const [session] = (await engine<{ sessions: { id: number }[] }>(win, '/api/assistant/sessions')).sessions;
    const saved = await engine<{ messages: { role: string }[]; turn_choices: { failure: { code: string; cost_usd: number | null } | null }[] }>(
      win, `/api/assistant/sessions/${session!.id}`);
    expect(saved.messages.map((m) => m.role)).toEqual(['user']);
    expect(saved.turn_choices[0]?.failure).toMatchObject({ code: 'cli_auth', cost_usd: null });
    await shoot(app, win, 'atlas-ask-failed-turn');

    // — signed in again, Check again sees it, and Try again answers ------------------------
    auth('signed_in');
    await failed.getByRole('button', { name: 'Check again' }).click();
    await expect(failed.locator('[data-ai="sign-in"]')).toHaveAttribute('data-state', 'signed_in', { timeout: 30_000 });
    await failed.getByRole('button', { name: 'Try again' }).click();
    const answer = pane.locator('.conv-msg[data-role="assistant"]');
    await expect(answer).toHaveCount(1, { timeout: 60_000 });
    await expect(pane.locator('.conv-working')).toHaveCount(0, { timeout: 30_000 });
    await expect(answer.locator('.conv-text')).toHaveText('Your most recent search was on perovskite stability.');
    await expect(answer.locator('.conv-cost')).toHaveText('Haiku 5.5 · high effort · Reported cost $0.0123, not an invoice');
    await expect(pane.locator('.conv-fixed')).toContainText('Claude Code · haiku (answered by Haiku 5.5) · effort high');
    // The earlier failure stays where it was, and is no longer the one to retry.
    await expect(failed).toHaveCount(1);
    await expect(pane.getByRole('button', { name: 'Try again' })).toHaveCount(0);
    await shoot(app, win, 'atlas-ask-answered-by');

    // — the next conversation's choice remembers what haiku last was -------------------------
    await win.getByRole('region', { name: 'Saved chats' }).getByRole('button', { name: 'New conversation' }).click();
    await expect(pane.locator('[data-ask="model-words"]'))
      .toHaveText('Model: haiku: the newest Haiku (Haiku 5.5 when it last answered).', { timeout: 30_000 });
    await expect(composing).toHaveAttribute('data-state', 'signed_in', { timeout: 30_000 });
    await shoot(app, win, 'atlas-ask-new-conversation');
    await win.evaluate(() => { window.location.hash = '#/settings/ai'; });
    await expect(win.locator('#assistant-model option[value="haiku"]'))
      .toHaveText('haiku: the newest Haiku (Haiku 5.5 when it last answered)', { timeout: 30_000 });

    // — a run whose lane was refused, and one that says which model wrote its summaries -----
    const [refused, answered] = JSON.parse(execFileSync(python, ['-c', SEED_RUNS, path.join(REPO_ROOT, 'resmon_scripts')],
      { env, encoding: 'utf8' })) as [number, number];
    await win.evaluate((id) => { window.location.hash = `#/runs/${id}`; }, refused);
    const lanes = win.locator('[data-run="summaries"] .run-ai-lanes li');
    await expect(lanes.first()).toContainText('not signed in, or its sign-in expired', { timeout: 30_000 });
    const runSignIn = lanes.first().locator('[data-ai="sign-in"]');
    await expect(runSignIn).toHaveAttribute('data-state', 'unchecked');
    await expect(runSignIn.getByRole('button', { name: 'Sign in' })).toBeVisible();
    await runSignIn.getByRole('button', { name: 'Check again' }).click();
    await expect(runSignIn).toHaveAttribute('data-state', 'signed_in', { timeout: 30_000 });
    await shoot(app, win, 'atlas-run-sign-in');
    await win.evaluate((id) => { window.location.hash = `#/runs/${id}`; }, answered);
    await expect(win.locator('[data-run="summaries"] .run-ai-lanes li').first())
      .toHaveText('Claude Code · haiku: summarized 2 of 2 papers. Written by Haiku 4.5.', { timeout: 30_000 });

    expect(problems, 'the renderer threw').toEqual([]);
  } finally {
    await app.close().catch(() => {});
  }
});
