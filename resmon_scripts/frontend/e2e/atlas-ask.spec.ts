/**
 * Atlas: Ask, in the real app, on the repository's agent-CLI double.
 *
 * The keyboard opens Ask with the caret in the composer; a read answers through
 * a tool row; a write waits behind a card holding the exact call, and Allow
 * really makes the watch; a turn goes on while Ask is not on screen and is
 * there on return; Stop ends a turn the runtime would have held for half a
 * minute; the rail filters by title; and Delete removes a conversation from
 * the engine as well as the screen. Each is held to the engine's own record.
 *
 * **The runtime is `fake_claude.py`**: the protocol, the permission handshake
 * over real HTTP and the tool call through the real MCP server are the app's;
 * what it replaces is the model. J13, J14, J17 and J31–J33 drive the same
 * screen through `journeys/drivers/atlas.ts`. No network beyond loopback.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { FRONTEND_ROOT, REPO_ROOT, SCREENSHOT_DIR, launchEnv, registerStateDir } from './fixtures/resmon-app';

const WATCH = { name: 'Atlas Ask watch', schedule: '0 7 * * 1', sources: ['arxiv'], keywords: ['perovskite'] };

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

test('Ask: the keyboard, a tool row, a card that really allows, a turn that outlives the screen, Stop, filter and delete', async () => {
  test.setTimeout(300_000);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-ask-')));
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(stateDir);
  const env: Record<string, string> = { ...launchEnv(stateDir, true), RESMON_UI: 'atlas', PYTHON_KEYRING_BACKEND: 'keyring.backends.null.Keyring' };
  const python = execFileSync(env.RESMON_PYTHON ?? 'python3', ['-c', 'import sys;print(sys.executable)'], { env, encoding: 'utf8' }).trim();
  const cli = path.join(root, 'claude');
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
    await engine(win, '/api/settings/ai', 'PUT', { settings: { ai_cli_path: cli } });
    const pane = win.getByRole('region', { name: 'Conversation' });
    const rail = win.getByRole('region', { name: 'Saved chats' });
    const composer = pane.getByLabel('Message the assistant');
    const sessions = async () => (await engine<{ sessions: { id: number; title: string }[] }>(win, '/api/assistant/sessions')).sessions;
    const settled = async () => {
      await expect.poll(async () => {
        for (const s of await sessions()) {
          const one = await engine<{ running: boolean; activity_observation: { turn_claimed: boolean } }>(win, `/api/assistant/sessions/${s.id}`);
          if (one.running || one.activity_observation.turn_claimed) return false;
        }
        return true;
      }, { timeout: 90_000 }).toBe(true);
      await expect(pane.locator('.conv-working')).toHaveCount(0, { timeout: 30_000 });
    };
    const send = async (text: string) => {
      await expect(composer).toBeEnabled({ timeout: 30_000 });
      await composer.fill(text);
      await pane.getByRole('button', { name: 'Send', exact: true }).click();
    };

    // — the keyboard: from Today, ⌘/ (Ctrl+/) is Ask with the caret in the composer ----
    await win.evaluate(() => { window.location.hash = '#/today'; });
    await win.keyboard.press(process.platform === 'darwin' ? 'Meta+Slash' : 'Control+Slash');
    await expect(win.getByRole('heading', { name: 'Ask', level: 1 })).toBeVisible({ timeout: 30_000 });
    await expect(composer).toBeFocused({ timeout: 30_000 });

    // — a read, through a tool row -------------------------------------------------------
    await send('SAY:the sources are listed\nCALL:list_sources {}');
    await settled();
    await expect(pane.locator('.conv-msg[data-role="assistant"] .conv-text')).toContainText('the sources are listed');
    await expect(pane.locator('.conv-call-name')).toContainText(['list_sources']);
    await expect(pane.locator('.conv-fixed')).toContainText('Claude Code');
    await expect(pane.locator('.conv-saved')).toContainText('Historical completion unknown.');

    // — a write waits behind the exact call, and Allow really makes the watch ------------
    await send(`CALL:create_routine ${JSON.stringify(WATCH)}`);
    const card = pane.locator('.conv-card');
    await expect(card).toBeVisible({ timeout: 60_000 });
    await expect(card.locator('.conv-card-call')).toHaveText(`create_routine(${JSON.stringify(WATCH, null, 2)})`);
    await expect(card.locator('.conv-card-title')).toHaveText(`Create a watch called “${WATCH.name}”, switched off`);
    await expect(pane.locator('.conv-call[data-state="held"]')).toContainText('waiting for your answer');
    await expect(card).toBeInViewport();
    expect((await engine<{ name: string }[]>(win, '/api/routines')).map((r) => r.name)).not.toContain(WATCH.name);
    await card.getByRole('button', { name: 'Allow', exact: true }).click();
    await settled();
    const made = (await engine<{ name: string; is_active: boolean | number }[]>(win, '/api/routines')).find((r) => r.name === WATCH.name);
    expect(made, 'Allow did not make the watch').toBeTruthy();
    expect(Boolean(made?.is_active), 'the assistant made a watch that is switched on').toBe(false);
    await expect(card).toHaveCount(0);

    // — a turn goes on while Ask is not on screen ----------------------------------------
    await send('SAY:started before leaving\nSLEEP:4\nSAY:finished while away');
    await expect(pane.locator('.conv-working')).toBeVisible({ timeout: 30_000 });
    await win.evaluate(() => { window.location.hash = '#/today'; });
    await expect(win.locator('nav[aria-label="Sections"] .tab-live')).toBeVisible();
    // The engine saves the answer while Ask is not on screen: the stream was held above it.
    await expect.poll(async () => {
      const id = (await sessions())[0]!.id;
      return (await engine<{ messages: { role: string; content: string }[] }>(win, `/api/assistant/sessions/${id}`)).messages
        .some((m) => m.role === 'assistant' && m.content.includes('finished while away'));
    }, { timeout: 60_000 }).toBe(true);
    await win.evaluate(() => { window.location.hash = '#/ask'; });
    await settled();
    await expect(pane.locator('.conv-msg[data-role="assistant"] .conv-text').last()).toContainText('finished while away');
    await expect(win.locator('nav[aria-label="Sections"] .tab-live')).toHaveCount(0);

    // — Stop ends a turn the runtime would have held for half a minute -------------------
    const before = Date.now();
    await send('SLEEP:30');
    const stop = pane.getByRole('button', { name: 'Stop', exact: true });
    await expect(stop).toBeVisible({ timeout: 30_000 });
    const cancelled = win.waitForResponse((r) => /\/api\/assistant\/sessions\/\d+\/cancel$/.test(r.url()));
    await stop.click();
    expect((await cancelled).ok()).toBe(true);
    await settled();
    expect(Date.now() - before, 'Stop did not end the turn before the runtime would have').toBeLessThan(25_000);
    await expect(composer).toBeEnabled();

    // — a second conversation, the filter, and delete ------------------------------------
    await rail.getByRole('button', { name: 'New conversation' }).click();
    await expect(pane.getByRole('heading', { name: 'New conversation' })).toBeVisible();
    await send('SAY:a second conversation to delete');
    await settled();
    await expect(rail.locator('.conv-row')).toHaveCount(2, { timeout: 30_000 });
    await rail.getByLabel('Filter saved titles').fill('second conversation');
    await expect(rail.locator('.conv-row')).toHaveCount(1, { timeout: 30_000 });
    await rail.getByLabel('Filter saved titles').fill('');
    await expect(rail.locator('.conv-row')).toHaveCount(2, { timeout: 30_000 });
    await pane.getByRole('button', { name: 'Delete', exact: true }).click();
    await pane.getByRole('group', { name: 'Confirm delete' }).getByRole('button', { name: 'Delete it' }).click();
    await expect(rail.locator('.conv-row')).toHaveCount(1, { timeout: 30_000 });
    await expect(pane.getByRole('heading', { name: 'New conversation' })).toBeVisible();
    expect((await sessions()).map((s) => s.title)).toEqual(['SAY:the sources are listed CALL:list_sources {}']);

    // — inside the window, at the size this suite launches -------------------------------
    await rail.locator('.conv-row').first().click();
    await expect(pane.locator('.conv-saved')).toBeVisible({ timeout: 30_000 });
    const box = (await pane.boundingBox())!;
    const view = await win.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    expect(box.y + box.height).toBeLessThanOrEqual(view.height + 1);
    expect(box.x + box.width).toBeLessThanOrEqual(view.width + 1);
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-ask.png') });
    expect(problems, 'the renderer threw').toEqual([]);
  } finally {
    await app.close().catch(() => {});
  }
});
