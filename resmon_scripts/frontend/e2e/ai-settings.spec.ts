/**
 * The AI settings page, in the real app — phase 1.8.5's controls and phase
 * 1.8.7's file picker.
 *
 * Everything here needs a *controlled answer* to "is an agent CLI installed on
 * this machine?", so these specs launch their own app rather than sharing the
 * worker-scoped one. `discover_cli` (`implementation_scripts/ai_cli.py`) looks
 * in three places in order — an explicit path, the known install locations,
 * then `PATH` — and the second uses `Path(...).expanduser()`, which reads
 * `HOME`. Pointing `HOME` at an empty temp directory and `PATH` at a directory
 * this spec builds makes both answers exact on any machine, including a CI
 * runner with neither CLI installed. Without that, "the fresh-install proposal
 * fires" would be a property that happens to hold on the author's laptop.
 *
 * The stub is never executed: `discover_cli` stats the file and reads its
 * permission bits, and says so in its own docstring — finding the file
 * establishes nothing about whether the CLI works or anyone is signed in.
 *
 * **What that control does *not* buy, and it took a red run to see it.** Two of
 * the known locations are absolute system paths — `/opt/homebrew/bin/claude`,
 * `/usr/local/bin/claude`, and `/Applications/ChatGPT.app/Contents/Resources/
 * codex` — and no environment variable hides those. On the machine this was
 * written on, `codex` really is installed at the third, so "a machine with no
 * agent CLI" is not something a test can manufacture here. Rather than assume,
 * every expectation below is derived from what `/api/settings/ai/cli-status`
 * actually reports on the machine the test is running on, and the two arms that
 * need an *absent* CLI skip with a printed reason when the machine has one. A
 * CI runner has neither installed, so those arms run there.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
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
  close: () => Promise<void>;
}

/**
 * Launch resmon with the machine's agent-CLI answer pinned.
 *
 * `cli` names the provider whose binary should appear on `PATH`, or null for a
 * machine where neither is installed.
 */
async function launchWithCli(cli: 'claude' | 'codex' | null): Promise<Launched> {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-ai-'));
  const home = path.join(stateDir, 'home');
  const bin = path.join(stateDir, 'bin');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });

  let stubPath: string | null = null;
  if (cli) {
    stubPath = path.join(bin, cli);
    // Never run — `discover_cli` stats it and checks os.access(X_OK). The body
    // is a valid script anyway, so an accidental execution is a no-op rather
    // than an error that would be read as the CLI misbehaving.
    fs.writeFileSync(stubPath, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(stubPath, 0o755);
  }

  const env = launchEnv(stateDir, true);
  env.HOME = home;
  // `/usr/bin:/bin` keeps the interpreter and the shell reachable while
  // guaranteeing neither real CLI is on it. `RESMON_PYTHON` is an absolute path
  // from the fixture, so the backend still starts.
  env.PATH = `${bin}:/usr/bin:/bin`;

  const app = await electron.launch({
    args: ['.', `--user-data-dir=${path.join(stateDir, 'electron-user-data')}`],
    cwd: FRONTEND_ROOT,
    env,
    timeout: 180_000,
  });
  const win = await app.firstWindow({ timeout: 180_000 });
  await win.waitForLoadState('domcontentloaded');
  await win.locator('.app-main').waitFor({ state: 'visible', timeout: 60_000 });

  const port = await win.evaluate(
    () => (window as unknown as { resmonAPI: { getBackendPort(): string } })
      .resmonAPI.getBackendPort(),
  );
  expect(port).not.toBe('8742');

  return {
    app,
    win,
    stateDir,
    stubPath,
    close: async () => {
      await app.close().catch(() => { /* already gone */ });
      fs.rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

/** Go to a hash route and let the page's first fetches settle. */
async function goto(win: Page, hash: string): Promise<void> {
  await win.evaluate((h) => { window.location.hash = `#${h}`; }, hash);
  await win.waitForFunction((h) => window.location.hash.startsWith(`#${h}`), hash,
    { timeout: 15_000 });
  await win.waitForLoadState('networkidle').catch(() => { /* long-poll pages never idle */ });
  await win.waitForTimeout(500);
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
    return (await fetch(`http://127.0.0.1:${port}/api/settings/ai/cli-status`)).json();
  });
  return data.providers as CliStatus[];
}

/** What `/api/settings/ai` says, read through the renderer's own origin. */
async function savedSettings(win: Page): Promise<Record<string, unknown>> {
  return win.evaluate(async () => {
    const port = (window as unknown as { resmonAPI: { getBackendPort(): string } })
      .resmonAPI.getBackendPort();
    return (await fetch(`http://127.0.0.1:${port}/api/settings/ai`)).json();
  });
}

test('the PATH stub is what makes the machine answer differently', async () => {
  // The control for every other test here. If a stub on `PATH` does not change
  // what the backend reports, the arms below are not the arms they claim to be.
  const found = await launchWithCli('claude');
  try {
    const status = await cliStatus(found.win);
    console.log('AI CLI STATUS (claude stub on PATH)', JSON.stringify(status));
    const claude = status.find((p) => p.provider === 'claude_code') as CliStatus;
    expect(claude.found).toBe(true);
    expect(claude.path).toBe(found.stubPath);
    // Found on PATH and *not* in a known location — the order matters, because
    // the packaged app's PATH is nearly empty and the known locations are what
    // carry it.
    expect(claude.how).toBe('path');
  } finally {
    await found.close();
  }

  const bare = await launchWithCli(null);
  try {
    const status = await cliStatus(bare.win);
    console.log('AI CLI STATUS (nothing on PATH)', JSON.stringify(
      status.map((p) => ({ provider: p.provider, found: p.found, how: p.how }))));
    const claude = status.find((p) => p.provider === 'claude_code') as CliStatus;
    expect(claude.found).toBe(false);
    expect(claude.tried).toContain('PATH (claude)');
  } finally {
    await bare.close();
  }
});

test('P10: a detected CLI is pre-selected on a fresh install, and nothing else happens', async () => {
  const { win, close } = await launchWithCli('claude');
  try {
    await goto(win, '/settings/ai');

    // What the backend found, in its own order — the proposal takes the first
    // one, so the expectation is derived rather than guessed.
    const status = await cliStatus(win);
    const expected = status.find((p) => p.found)?.provider;
    expect(expected).toBeTruthy();

    // Selected in the form …
    const provider = win.locator('select').first();
    await expect(provider).toHaveValue(expected as string);
    // … and said out loud, because a form that silently chose for you is worse
    // than one that did not.
    await expect(win.locator('.app-main'))
      .toContainText('resmon found this command on your machine and selected it');

    // … and nothing was written. The proposal is a selection in a form, not a
    // configuration change: the saved settings still have no provider and AI is
    // still off. This is the half a jsdom guard cannot see, because there is no
    // backend behind it to have been written to.
    const saved = await savedSettings(win);
    console.log('P10 PROPOSED', expected, 'SAVED', JSON.stringify({
      ai_provider: saved.ai_provider, ai_enabled: saved.ai_enabled,
    }));
    expect(saved.ai_provider ?? '').toBe('');
    expect(saved.ai_enabled).toBeFalsy();
  } finally {
    await close();
  }
});

test('P10b: the proposal never overwrites a provider that is already chosen', async () => {
  const { win, close } = await launchWithCli('claude');
  try {
    // Configure a different provider first, through the API the settings page
    // itself writes to.
    await win.evaluate(async () => {
      const port = (window as unknown as { resmonAPI: { getBackendPort(): string } })
        .resmonAPI.getBackendPort();
      const res = await fetch(`http://127.0.0.1:${port}/api/settings/ai`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          settings: { ai_provider: 'openai', ai_enabled: 'false' },
        }),
      });
      if (!res.ok) throw new Error(`PUT failed: ${res.status} ${await res.text()}`);
    });

    await goto(win, '/settings/ai');
    const provider = win.locator('select').first();
    await expect(provider).toHaveValue('openai');
    await expect(win.locator('.app-main'))
      .not.toContainText('resmon found this command on your machine and selected it');
  } finally {
    await close();
  }
});

test('P10c: with no CLI on the machine, nothing is proposed', async () => {
  const { win, close } = await launchWithCli(null);
  try {
    const status = await cliStatus(win);
    const installed = status.filter((p) => p.found);
    if (installed.length > 0) {
      // Say what this run did not verify, rather than passing quietly. The
      // absent-CLI arm needs a machine with neither installed; a CI runner is
      // one and a developer's laptop usually is not.
      console.log('P10c NOT VERIFIED — this machine really has',
        JSON.stringify(installed.map((p) => `${p.provider} at ${p.path}`)));
      test.skip(true, `this machine has ${installed.map((p) => p.provider).join(', ')} installed`);
    }
    await goto(win, '/settings/ai');
    const provider = win.locator('select').first();
    await expect(provider).toHaveValue('');
    await expect(win.locator('.app-main'))
      .not.toContainText('resmon found this command on your machine and selected it');
  } finally {
    await close();
  }
});

test('5d: every agent CLI the backend knows about leads the primary provider list', async () => {
  const { win, close } = await launchWithCli(null);
  try {
    await goto(win, '/settings/ai');
    // The denominator is the backend's own list of subscription providers —
    // what `/api/settings/ai/cli-status` enumerates — not two names written
    // down here. A third agent CLI added to `ai_cli.SUPPORTED_CLI_PROVIDERS`
    // and forgotten in the dropdown fails this.
    const subscription = (await cliStatus(win)).map((p) => p.provider).sort();
    const options = await win.locator('select').first().locator('option')
      .evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value));
    console.log('5d PRIMARY PROVIDER OPTIONS', JSON.stringify(options),
      'SUBSCRIPTION', JSON.stringify(subscription));
    for (const provider of subscription) expect(options).toContain(provider);

    // v1.8.5 made the subscription lanes the *primary* route, and part of that
    // claim is the order the choices are offered in — they lead, ahead of every
    // API-key provider.
    const real = options.filter((o) => o !== '');
    expect(real.slice(0, subscription.length).sort()).toEqual(subscription);
  } finally {
    await close();
  }
});

test('5d: the Advanced path field opens by itself exactly when the CLI was not found', async () => {
  // Not found: the disclosure is open, because the field is the answer.
  const bare = await launchWithCli(null);
  try {
    const status = await cliStatus(bare.win);
    const missing = status.find((p) => !p.found);
    expect(missing, 'this machine has every agent CLI installed').toBeTruthy();
    await goto(bare.win, '/settings/ai');
    await bare.win.locator('select').first().selectOption((missing as CliStatus).provider);
    await expect(bare.win.locator('[aria-label="Primary command path"]')).toBeVisible();
    await expect(bare.win.locator(
      `[data-testid="primary-cli-status-${(missing as CliStatus).provider}"]`,
    )).toContainText('⚠');
  } finally {
    await bare.close();
  }

  // Found: it stays shut, because there is nothing to fix.
  const found = await launchWithCli('claude');
  try {
    await goto(found.win, '/settings/ai');
    await found.win.locator('select').first().selectOption('claude_code');
    await expect(found.win.locator('[data-testid="primary-cli-status-claude_code"]'))
      .toContainText('✓');
    await expect(found.win.locator('[aria-label="Primary command path"]')).toBeHidden();
  } finally {
    await found.close();
  }
});

test('P5: the stubbed file dialog fills the Advanced path field', async () => {
  const { app, win, close } = await launchWithCli(null);
  try {
    // The dialog is replaced in the main process, so `dialog.showOpenDialog` is
    // never reached — a real one would block the run until a human dismissed it.
    await installIpcGuards(app);
    await goto(win, '/settings/ai');
    // Whichever agent CLI this machine does not have — its Advanced field is
    // the one that opens on its own.
    const missing = (await cliStatus(win)).find((p) => !p.found);
    expect(missing).toBeTruthy();
    await win.locator('select').first().selectOption((missing as CliStatus).provider);

    const field = win.locator('[aria-label="Primary command path"]');
    await expect(field).toBeVisible();
    await expect(field).toHaveValue('');

    await win.locator('[aria-label="Browse for the command"]').click();
    await expect(field).toHaveValue('/tmp/e2e-chosen-file');

    const guards = await readGuards(app);
    console.log('P5 GUARD COUNTS', JSON.stringify(guards.stubbed), JSON.stringify(guards.escaped));
    // The renderer went through the bridge exactly once …
    expect(guards.stubbed.chooseFile).toBe(1);
    // … and the real picker was never opened.
    expect(guards.escaped.showOpenDialog).toBe(0);

    // And the field is a real edit: what the picker returned is what gets saved.
    await win.locator('button.btn-primary', { hasText: /^Save$/ }).first().click();
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
