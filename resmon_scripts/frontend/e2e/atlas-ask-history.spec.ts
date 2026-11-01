/**
 * Atlas's Ask, over a conversation that was saved before it: continuing one
 * that has no kept connection, Deny on a write, a long answer at twice the
 * zoom, and Settings › AI saved underneath it.
 *
 * - **Continuing an old conversation asks first.** One saved before resmon
 *   kept a conversation's connection is authored into the database. Sending
 *   in it shows what will be fixed and that the new session receives only the
 *   new message, and nothing is sent until Confirm and send.
 * - **Deny is exact.** The card's Deny sends `{ allow: false }` and nothing
 *   is made.
 * - **A long answer keeps the controls reachable.** A 1,200-character word
 *   widens nothing, and at twice the zoom the composer and Send can still be
 *   reached.
 * - **Saving the assistant's settings keeps the history.** Every saved
 *   conversation and message is still there afterwards.
 *
 * The runtime is `fake_claude.py`, configured as the command; discovery is
 * configured-only, so nothing else can run.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { FRONTEND_ROOT, REPO_ROOT, SCREENSHOT_DIR, ATLAS_LANDMARK, atlasEnv, launchEnv, registerStateDir } from './fixtures/resmon-app';

const WATCH = { name: 'Denied Atlas watch', schedule: '0 7 * * 1', sources: ['arxiv'], keywords: ['perovskite'] };
const LONG = 'longword'.repeat(150);

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

interface Session { id: number; title: string }
interface Detail { running: boolean; activity_observation: { turn_claimed: boolean }; messages: { role: string; content: string }[] }

test('Ask: an old conversation continued with consent, an exact Deny, a long answer at twice the zoom, and settings saved under it', async () => {
  test.setTimeout(300_000);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-ask-history-')));
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(stateDir);
  const env: Record<string, string> = { ...atlasEnv(launchEnv(stateDir, true)), RESMON_DISABLE_SCHEDULER: '1' };
  const python = execFileSync(env.RESMON_PYTHON, ['-c', 'import sys;print(sys.executable)'], { env, encoding: 'utf8' }).trim();
  const cli = path.join(root, 'claude');
  fs.writeFileSync(cli, `#!/bin/sh\nexec "${python}" "${path.join(REPO_ROOT, 'resmon_scripts/verification_scripts/fixtures/fake_claude.py')}" "$@"\n`, { mode: 0o755 });
  // A conversation saved before resmon kept a conversation's connection.
  execFileSync(python, ['-c', `import sys
sys.path.insert(0,'resmon_scripts')
from implementation_scripts import database,assistant_store as s
p=sys.argv[1];database.init_db(p);c=database.get_connection(p)
sid=s.create_session(c,runtime='claude_cli',title='An older conversation')
s.add_message(c,sid,role='user',content='an earlier question')
s.add_message(c,sid,role='assistant',content='an earlier answer')
c.commit()`, env.RESMON_DB_PATH], { env, encoding: 'utf8', cwd: REPO_ROOT });

  const app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(stateDir, 'electron-user-data')}`], cwd: FRONTEND_ROOT, env, timeout: 180_000 });
  registerStateDir(stateDir);
  try {
    const win = await app.firstWindow({ timeout: 180_000 });
    const problems: string[] = [];
    win.on('pageerror', (e) => problems.push(e.message));
    await win.locator(ATLAS_LANDMARK).waitFor({ state: 'visible', timeout: 120_000 });
    await engine(win, '/api/settings/ai', 'PUT', { settings: { ai_cli_path: cli } });
    const pane = win.getByRole('region', { name: 'Conversation' });
    const rail = win.getByRole('region', { name: 'Saved chats' });
    const composer = pane.getByLabel('Message the assistant');
    const sessions = async () => (await engine<{ sessions: Session[] }>(win, '/api/assistant/sessions')).sessions;
    const detail = (id: number) => engine<Detail>(win, `/api/assistant/sessions/${id}`);
    const settled = async (id: number) => {
      await expect.poll(async () => {
        const one = await detail(id);
        return !one.running && !one.activity_observation.turn_claimed;
      }, { timeout: 90_000 }).toBe(true);
      await expect(pane.locator('.conv-working')).toHaveCount(0, { timeout: 30_000 });
    };
    const [older] = await sessions();
    expect(older.title).toBe('An older conversation');

    // — continuing it asks first, and says what the new session receives ----------------
    await win.evaluate(() => { window.location.hash = '#/ask'; });
    await rail.locator('.conv-row', { hasText: 'An older conversation' }).click();
    await expect(pane.locator('.conv-msg')).toHaveCount(2, { timeout: 30_000 });
    await composer.fill('SAY:after the consent');
    await pane.getByRole('button', { name: 'Send', exact: true }).click();
    const adopt = pane.getByRole('group', { name: 'Continue a conversation saved before choices were kept' });
    await expect(adopt).toBeVisible({ timeout: 30_000 });
    await expect(adopt).toContainText('it receives your new message, not the earlier conversation');
    expect((await detail(older.id)).messages, 'a message was sent before Confirm and send').toHaveLength(2);
    await adopt.getByRole('button', { name: 'Confirm and send', exact: true }).click();
    await settled(older.id);
    const continued = (await detail(older.id)).messages;
    expect(continued.slice(0, 2).map((m) => m.content)).toEqual(['an earlier question', 'an earlier answer']);
    expect(continued.some((m) => m.role === 'assistant' && m.content.includes('after the consent'))).toBe(true);

    // — Deny is exact, and nothing is made ------------------------------------------------
    await composer.fill(`CALL:create_routine ${JSON.stringify(WATCH)}`);
    await pane.getByRole('button', { name: 'Send', exact: true }).click();
    const card = pane.locator('.conv-card');
    await expect(card).toBeVisible({ timeout: 60_000 });
    const answered = win.waitForResponse((r) => /\/permissions\//.test(r.url()) && r.request().method() === 'POST');
    await card.getByRole('button', { name: 'Deny', exact: true }).click();
    expect((await answered).request().postDataJSON()).toEqual({ allow: false });
    await settled(older.id);
    expect((await engine<{ name: string }[]>(win, '/api/routines')).map((r) => r.name)).not.toContain(WATCH.name);
    await expect(card).toHaveCount(0);

    // — a long answer, at twice the zoom, widens nothing and leaves the controls reachable --
    await composer.fill(`SAY:${LONG}`);
    await pane.getByRole('button', { name: 'Send', exact: true }).click();
    await settled(older.id);
    await expect(pane.locator('.conv-msg[data-role="assistant"] .conv-text').last()).toContainText(LONG.slice(0, 40));
    const sideways = () => win.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    const atOne = await sideways();
    expect(atOne.scroll, 'the long word pushed the page sideways').toBeLessThanOrEqual(atOne.client);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(2));
    // Twice the zoom puts the window under Atlas's 960-pixel layout minimum, so
    // the page may scroll sideways there; what is held is that the controls
    // can still be reached.
    await expect.poll(async () => (await sideways()).client).toBeLessThan(atOne.client);
    console.log('ATLAS ASK ZOOM', JSON.stringify({ atOne, atTwo: await sideways() }));
    await composer.focus();
    await expect(composer).toBeFocused();
    const send = pane.getByRole('button', { name: 'Send', exact: true });
    await send.scrollIntoViewIfNeeded();
    await expect(send).toBeInViewport();
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-ask-zoom200.png') });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1));

    // — Settings › AI saved under it keeps every conversation and message -------------------
    const kept = { sessions: await sessions(), messages: (await detail(older.id)).messages };
    await win.evaluate(() => { window.location.hash = '#/settings/ai'; });
    const form = win.getByRole('form', { name: 'Assistant settings' });
    const model = form.locator('#assistant-model');
    await expect(model).toBeVisible({ timeout: 30_000 });
    const other = await model.evaluate((select) => {
      const s = select as HTMLSelectElement;
      return [...s.options].map((o) => o.value).find((v) => v && v !== s.value) ?? '';
    });
    expect(other, 'Settings › AI offers no other model to save').not.toBe('');
    await model.selectOption(other);
    await form.getByRole('button', { name: 'Save assistant settings', exact: true }).click();
    await expect(form.getByRole('status')).toHaveText('Saved. New conversations start from these.', { timeout: 30_000 });
    expect(await sessions()).toEqual(kept.sessions);
    expect((await detail(older.id)).messages).toEqual(kept.messages);
    await win.evaluate(() => { window.location.hash = '#/ask'; });
    await expect(rail.locator('.conv-row', { hasText: 'An older conversation' })).toBeVisible({ timeout: 30_000 });

    expect(problems).toEqual([]);
  } finally {
    await app.close().catch(() => { /* already gone */ });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
