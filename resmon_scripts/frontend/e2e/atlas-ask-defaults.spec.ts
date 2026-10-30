/**
 * Ask's defaults, saved in Settings › AI while the window is open, are what the
 * next new conversation starts with: no reopening the window. A choice the
 * person made in the composer is theirs, and a later saved default does not
 * replace it until New conversation is pressed. Nothing is sent, so no command
 * runs.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { FRONTEND_ROOT, REPO_ROOT, launchEnv, registerStateDir } from './fixtures/resmon-app';

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

test('Ask: a default saved in Settings › AI reaches the next new conversation, and the person’s own choice stays', async () => {
  test.setTimeout(240_000);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-ask-defaults-')));
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(stateDir);
  const env: Record<string, string> = { ...launchEnv(stateDir, true), RESMON_UI: 'atlas' };
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
    const nav = win.getByRole('navigation', { name: 'Sections' });
    await expect(nav).toBeVisible({ timeout: 120_000 });
    await engine(win, '/api/settings/ai', 'PUT', { settings: { ai_cli_path: cli } });

    // Ask, before anything is saved: the composer holds the defaults as they stand.
    await nav.getByRole('link', { name: 'Ask' }).click();
    const pane = win.getByRole('region', { name: 'Conversation' });
    const model = pane.locator('#conv-model');
    await expect(model).toBeVisible({ timeout: 60_000 });
    const before = await model.inputValue();

    // Settings › AI: a different default model for Ask, saved.
    const saveDefault = async (alias: string) => {
      await win.evaluate(() => { window.location.hash = '#/settings/ai'; });
      const form = win.getByRole('form', { name: 'Assistant settings' });
      const select = form.locator('#assistant-model');
      await expect(select).toBeVisible({ timeout: 30_000 });
      await select.selectOption(alias);
      await form.getByRole('button', { name: 'Save assistant settings', exact: true }).click();
      await expect(form.getByRole('status')).toHaveText(/^Saved\./, { timeout: 30_000 });
      const stored = await engine<{ assistant_model?: string }>(win, '/api/settings/assistant');
      expect(stored.assistant_model).toBe(alias);
    };
    const aliases = await (async () => {
      await win.evaluate(() => { window.location.hash = '#/settings/ai'; });
      const select = win.getByRole('form', { name: 'Assistant settings' }).locator('#assistant-model');
      await expect(select).toBeVisible({ timeout: 30_000 });
      return (await select.locator('option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value)))
        .filter((v) => v && v !== before);
    })();
    expect(aliases.length, 'Settings › AI offers no other model to choose').toBeGreaterThan(1);
    const [first, second] = aliases as [string, string];
    await saveDefault(first);

    // Back in Ask, the same window: the next new conversation starts with it.
    await nav.getByRole('link', { name: 'Ask' }).click();
    await expect(model).toHaveValue(first, { timeout: 30_000 });

    // The person's own choice in the composer is theirs: a later default leaves it.
    await model.fill('my-own-model');
    await saveDefault(second);
    await nav.getByRole('link', { name: 'Ask' }).click();
    await expect(model).toBeVisible({ timeout: 30_000 });
    await expect(model).toHaveValue('my-own-model');

    // New conversation starts from the saved defaults, even when the composer is
    // already a new conversation; the unsent text stays where it was.
    const message = pane.getByLabel('Message the assistant');
    await message.fill('words not sent yet');
    await win.getByRole('region', { name: 'Saved chats' }).getByRole('button', { name: 'New conversation' }).click();
    await expect(model).toHaveValue(second, { timeout: 30_000 });
    await expect(message).toHaveValue('words not sent yet');

    expect(problems, 'the renderer threw').toEqual([]);
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});
