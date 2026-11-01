/**
 * Settings › AI in the real app: where resmon looks for an agent command, what
 * it says it found, and the file picker for naming one.
 *
 * Everything here needs a *controlled answer* to "is an agent CLI installed on
 * this machine?", so these specs launch their own app rather than sharing the
 * worker-scoped one. `discover_cli` (`implementation_scripts/ai_cli.py`) looks
 * in three places in order: an explicit path, the installers' known
 * locations, then `PATH`.
 *
 * **No command of the person's is ever found, so none is ever run.** Settings ›
 * AI asks the command whether it is signed in when it opens, and lists Codex's
 * models by running it, so whatever discovery finds is executed. The known
 * locations include absolute paths no variable hides
 * (`/Applications/ChatGPT.app/Contents/Resources/codex` exists on the machine
 * this was written on), so the engine runs with
 * `RESMON_AI_CLI_DISCOVERY=path-only`, which skips them, and `PATH` and `HOME`
 * are pinned to directories this spec made. The only command it can find is a
 * stub written here, which records how it was called and says it is not signed
 * in. `onlyStubs` is the guard: every launch checks before any screen is
 * opened that discovery can see nothing outside this spec's directory, and
 * checks again at the end that every sign-in check the window made named a
 * stub or nothing.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { launchEnv, FRONTEND_ROOT } from './fixtures/resmon-app';
import { installIpcGuards, readGuards } from './fixtures/ipc-guards';

test.describe.configure({ mode: 'serial' });

interface Launched {
  app: ElectronApplication;
  win: Page;
  stateDir: string;
  /** The fake CLI's path, when this launch was given one. */
  stubPath: string | null;
  /** How the stubs were called: one line of arguments a call. */
  stubCalls: () => string[];
  close: () => Promise<void>;
}

/**
 * Launch resmon with the machine's agent-CLI answer pinned.
 *
 * `cli` names the provider whose binary should appear on `PATH`, or null for a
 * machine where neither is installed. `settings` are stored before the window
 * opens any screen.
 */
async function launchWithCli(cli: 'claude' | 'codex' | null, settings: Record<string, string> = {}): Promise<Launched> {
  const stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-ai-')));
  const home = path.join(stateDir, 'home');
  const bin = path.join(stateDir, 'bin');
  const calls = path.join(stateDir, 'stub-calls.log');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });

  let stubPath: string | null = null;
  if (cli) {
    stubPath = path.join(bin, cli);
    // Run by the sign-in check and by Codex's model list. It records the call
    // and answers as a command nobody has signed in to.
    fs.writeFileSync(stubPath, `#!/bin/sh\necho "$0 $*" >> "${calls}"\necho "Not logged in"\nexit 1\n`);
    fs.chmodSync(stubPath, 0o755);
  }
  // Sign in would open Terminal; this records the path it was handed instead.
  const opener = path.join(stateDir, 'opener');
  fs.writeFileSync(opener, `#!/bin/sh\necho "opened $*" >> "${calls}"\n`);
  fs.chmodSync(opener, 0o755);

  const env: Record<string, string> = { ...launchEnv(stateDir, true), RESMON_UI: 'atlas' };
  env.HOME = home;
  // Discovery itself is under test, so the engine searches, but only PATH.
  env.RESMON_AI_CLI_DISCOVERY = 'path-only';
  env.RESMON_SIGN_IN_OPENER = opener;

  // The backend interpreter has to be resolved **before** PATH is replaced.
  // In a checkout `pythonPath()` returns the venv's absolute path and this is a
  // no-op; on CI it returns the bare name `python3`, and the runner's real
  // interpreter is on the inherited PATH and nowhere else.
  if (env.RESMON_PYTHON && !path.isAbsolute(env.RESMON_PYTHON)) {
    try {
      env.RESMON_PYTHON = execFileSync(
        process.platform === 'win32' ? 'where' : 'which',
        [env.RESMON_PYTHON], { encoding: 'utf8' },
      ).split('\n')[0].trim();
    } catch {
      /* leave the name; the launch failure below will say so */
    }
  }
  // A PATH with exactly one thing on it that this spec put there, plus the
  // system directories Electron's own helpers need.
  env.PATH = [bin, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter);

  const app = await electron.launch({
    args: ['.', `--user-data-dir=${path.join(stateDir, 'electron-user-data')}`],
    cwd: FRONTEND_ROOT,
    env,
    timeout: 180_000,
  });
  const win = await app.firstWindow({ timeout: 180_000 });
  const checks: unknown[] = [];
  win.on('response', async (response) => {
    if (new URL(response.url()).pathname !== '/api/ai/cli/sign-in') return;
    try { checks.push(await response.json()); } catch { /* not a body this guard reads */ }
  });
  await expect(win.getByRole('navigation', { name: 'Sections' })).toBeVisible({ timeout: 120_000 });
  const port = await win.evaluate(
    () => (window as unknown as { resmonAPI: { getBackendPort(): string } }).resmonAPI.getBackendPort(),
  );
  expect(port).not.toBe('8742');
  if (Object.keys(settings).length) await putSettings(win, settings);
  await onlyStubs(win, stateDir, []);

  return {
    app,
    win,
    stateDir,
    stubPath,
    stubCalls: () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean) : []),
    close: async () => {
      try {
        await onlyStubs(win, stateDir, checks);
      } finally {
        await app.close().catch(() => { /* already gone */ });
        fs.rmSync(stateDir, { recursive: true, force: true });
      }
    },
  };
}

/**
 * The guard: discovery can see nothing but this spec's stubs, and every sign-in
 * check the window made ran a stub or nothing. A command found anywhere else
 * would be run by the next screen that asks it whether it is signed in.
 */
async function onlyStubs(win: Page, stateDir: string, checks: unknown[]): Promise<void> {
  const inside = (where: string | null) => where === null || where.startsWith(`${stateDir}${path.sep}`);
  const outside = (await cliStatus(win)).filter((p) => !inside(p.path)).map((p) => `${p.provider} at ${p.path}`);
  for (const check of checks as { provider?: string; path?: string | null }[]) {
    if (!inside(check.path ?? null)) outside.push(`a sign-in check of ${check.provider} ran ${check.path}`);
  }
  expect(outside, 'a command outside this spec was found, so a screen would run it').toEqual([]);
}

/** Go to a hash route and wait for the screen's own landmark. */
async function goto(win: Page, hash: string): Promise<void> {
  await win.evaluate((h) => { window.location.hash = `#${h}`; }, hash);
  await win.waitForFunction((h) => window.location.hash.startsWith(`#${h}`), hash, { timeout: 15_000 });
  await expect(win.locator('main.stage')).toBeVisible({ timeout: 15_000 });
}

/** Store AI settings through the route Settings › AI writes to. */
async function putSettings(win: Page, settings: Record<string, string>): Promise<void> {
  await win.evaluate(async (body) => {
    const port = (window as unknown as { resmonAPI: { getBackendPort(): string } }).resmonAPI.getBackendPort();
    const res = await e2eFetch(`http://127.0.0.1:${port}/api/settings/ai`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: body }),
    });
    if (!res.ok) throw new Error(`PUT failed: ${res.status} ${await res.text()}`);
  }, settings);
}

interface CliStatus {
  provider: string;
  path: string | null;
  how: string;
  found: boolean;
  tried: string[];
  detail: string;
}

/** What the backend says is installed on *this* machine. */
async function cliStatus(win: Page): Promise<CliStatus[]> {
  const data = await win.evaluate(async () => {
    const port = (window as unknown as { resmonAPI: { getBackendPort(): string } })
      .resmonAPI.getBackendPort();
    return (await e2eFetch(`http://127.0.0.1:${port}/api/settings/ai/cli-status`)).json();
  });
  return data.providers as CliStatus[];
}

/** What `/api/settings/ai` says, read through the renderer's own origin. */
async function savedSettings(win: Page): Promise<Record<string, unknown>> {
  return win.evaluate(async () => {
    const port = (window as unknown as { resmonAPI: { getBackendPort(): string } })
      .resmonAPI.getBackendPort();
    return (await e2eFetch(`http://127.0.0.1:${port}/api/settings/ai`)).json();
  });
}

test('the PATH stub is what makes the machine answer differently, and nothing installed is found', async () => {
  // The control for every other test here. If a stub on `PATH` does not change
  // what the backend reports, the arms below are not the arms they claim to be.
  const found = await launchWithCli('claude');
  try {
    const status = await cliStatus(found.win);
    console.log('AI CLI STATUS (claude stub on PATH)', JSON.stringify(status));
    const claude = status.find((p) => p.provider === 'claude_code') as CliStatus;
    expect(claude.found).toBe(true);
    expect(claude.path).toBe(found.stubPath);
    expect(claude.how).toBe('path');
  } finally {
    await found.close();
  }

  // Nothing on PATH: nothing is found on this machine either, whatever the
  // person has installed, so the arms that need an absent command run here too.
  const bare = await launchWithCli(null);
  try {
    const status = await cliStatus(bare.win);
    console.log('AI CLI STATUS (nothing on PATH)', JSON.stringify(
      status.map((p) => ({ provider: p.provider, found: p.found, how: p.how }))));
    expect(status.filter((p) => p.found)).toEqual([]);
    for (const provider of status) {
      expect(provider.tried[0]).toContain('known locations not searched');
    }
    expect((status.find((p) => p.provider === 'claude_code') as CliStatus).tried).toContain('PATH (claude)');
  } finally {
    await bare.close();
  }
});

test('Settings › AI says where it found the command, or where it looked', async () => {
  const found = await launchWithCli('claude', { ai_provider: 'claude_code' });
  try {
    await goto(found.win, '/settings/ai');
    const lane = found.win.locator('[data-ai="lane-status"]');
    await expect(lane).toHaveAttribute('data-found', 'true', { timeout: 30_000 });
    await expect(lane).toContainText(found.stubPath as string);
    // Opening the page asked the command whether it is signed in: the stub was what ran.
    await expect.poll(() => found.stubCalls().some((call) => call.includes('auth status')), { timeout: 30_000 }).toBe(true);
  } finally {
    await found.close();
  }

  const bare = await launchWithCli(null, { ai_provider: 'claude_code' });
  try {
    await goto(bare.win, '/settings/ai');
    const lane = bare.win.locator('[data-ai="lane-status"]');
    await expect(lane).toHaveAttribute('data-found', 'false', { timeout: 30_000 });
    await expect(lane).toContainText('Looked in:');
    await expect(lane).toContainText('PATH (claude)');
    expect(bare.stubCalls().filter((call) => !call.startsWith('opened'))).toEqual([]);
  } finally {
    await bare.close();
  }
});

test('5d: every agent CLI the backend knows about leads the provider list', async () => {
  const { win, close } = await launchWithCli(null);
  try {
    await goto(win, '/settings/ai');
    // The denominator is the backend's own list of subscription providers,
    // not two names written down here.
    const subscription = (await cliStatus(win)).map((p) => p.provider).sort();
    const options = await win.locator('#ai-provider option')
      .evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value));
    console.log('5d PROVIDER OPTIONS', JSON.stringify(options), 'SUBSCRIPTION', JSON.stringify(subscription));
    const real = options.filter((o) => o !== '');
    expect(real.slice(0, subscription.length).sort()).toEqual(subscription);
  } finally {
    await close();
  }
});

test('P5: the stubbed file dialog fills the command field, and what it names is saved', async () => {
  const { app, win, close } = await launchWithCli(null, { ai_provider: 'claude_code' });
  try {
    // The dialog is replaced in the main process, so `dialog.showOpenDialog` is
    // never reached; a real one would block the run until a human dismissed it.
    await installIpcGuards(app);
    await goto(win, '/settings/ai');
    const field = win.locator('#ai-cli-path');
    await expect(field).toBeVisible({ timeout: 30_000 });
    await expect(field).toHaveValue('');

    await win.locator('[data-ai="choose-command"]').click();
    await expect(field).toHaveValue('/tmp/e2e-chosen-file');

    const guards = await readGuards(app);
    console.log('P5 GUARD COUNTS', JSON.stringify(guards.stubbed), JSON.stringify(guards.escaped));
    expect(guards.stubbed.chooseFile).toBe(1);
    expect(guards.escaped.showOpenDialog).toBe(0);

    // The field is a real edit: what the picker returned is what gets saved.
    await win.getByRole('button', { name: 'Save summary settings' }).click();
    await expect.poll(async () => (await savedSettings(win)).ai_cli_path, { timeout: 20_000 })
      .toBe('/tmp/e2e-chosen-file');
  } finally {
    await close();
  }
});

test('P5b: the picker asks for the two things both CLIs need it to ask for', async () => {
  // `claude` lives under a hidden `~/.local`; `codex` lives *inside*
  // ChatGPT.app, which macOS treats as a single file. A picker without
  // `showHiddenFiles` and `treatPackageAsDirectory` cannot reach either — a
  // button that fails for exactly the users who need it.
  //
  // The options are captured from the **real** handler as the renderer drives
  // it, rather than read out of the source, so a refactor that drops one is
  // caught rather than a comment that stops being true.
  const { app, win, close } = await launchWithCli(null);
  try {
    await app.evaluate(async ({ dialog }) => {
      const store: { opts: unknown } = { opts: null };
      (globalThis as unknown as { __p5b: typeof store }).__p5b = store;
      dialog.showOpenDialog = (async (_w: unknown, o: unknown) => {
        store.opts = o;
        return { canceled: true, filePaths: [] };
      }) as unknown as typeof dialog.showOpenDialog;
    });

    const returned = await win.evaluate(async () =>
      (window as unknown as {
        resmonAPI: { chooseFile(d?: string): Promise<string | null> };
      }).resmonAPI.chooseFile('/tmp/somewhere'));
    // A cancelled dialog answers null, and the field is left alone.
    expect(returned).toBeNull();

    const seen = await app.evaluate(async () =>
      (globalThis as unknown as {
        __p5b: { opts: { properties: string[]; defaultPath?: string } };
      }).__p5b.opts);
    console.log('P5b DIALOG OPTIONS', JSON.stringify(seen));
    expect([...seen.properties].sort())
      .toEqual(['openFile', 'showHiddenFiles', 'treatPackageAsDirectory']);
    // Opening where the user last pointed it, rather than at the home
    // directory they were told the file is not in.
    expect(seen.defaultPath).toBe('/tmp/somewhere');
  } finally {
    await close();
  }
});
