/**
 * The packaged app's command line, launched the way a person gets it.
 *
 * The release workflow runs this on every target after the build. It checks, on
 * the files that ship:
 *
 *   1. `resmon --version` (the bundled interpreter running the bundled
 *      `resmon.pyz`, isolated) names this build's version and the app it sits in.
 *   2. With the packaged app launched against an isolated instance, `resmon
 *      service status --json` and two read commands answer from that instance.
 *   3. The engine started a map fit and a PDF worker, and both finished.
 *   4. On Windows, no console window appeared at any point (the watcher in
 *      `fixtures/watch-windows.ps1`), and the app's folder is byte for byte as it
 *      was: nothing wrote bytecode into the bundle.
 *
 * It skips when there is no packaged app, as `packaged.spec.ts` does, unless
 * `RESMON_REQUIRE_PACKAGED=1` (the release workflow sets it), when a missing or
 * stale build fails instead: a release must never pass by not looking.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { launchEnv, atlasEnv, ATLAS_LANDMARK } from './fixtures/resmon-app';
import { SEED } from './fixtures/maps';
import { writePdf } from './fixtures/pdf';
import {
  CHECKOUT_VERSION, appFolder, bundledBackend, packagedExecutable, runToEnd, terminalEnv,
} from './fixtures/packaged-app';
import { changesBetween, snapshotTree } from './fixtures/app-tree';
import { consoleWindowsShown, describeWindows, startWindowWatch, type WindowWatch } from './fixtures/console-windows';

const REQUIRED = process.env.RESMON_REQUIRE_PACKAGED === '1';

/** Skip, or fail when the run is a release's. */
function unavailable(reason: string): never {
  if (REQUIRED) throw new Error(reason);
  test.skip(true, reason);
  throw new Error(reason);
}

/** A call to the engine from the page, as the Library's own requests are made. */
async function engine<T>(win: Page, route: string, init: { method?: string; json?: unknown; bytes?: number[] } = {}): Promise<T> {
  return win.evaluate(async ([r, i]) => {
    const port = (window as unknown as { resmonAPI: { getBackendPort(): string } }).resmonAPI.getBackendPort();
    const headers: Record<string, string> = { 'X-Resmon-Library': '1' };
    let body: BodyInit | undefined;
    if (i.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(i.json);
    } else if (i.bytes) {
      headers['Content-Type'] = 'application/octet-stream';
      body = new Uint8Array(i.bytes);
    }
    const response = await e2eFetch(`http://127.0.0.1:${port}${r}`, { method: i.method ?? 'GET', headers, body });
    if (!response.ok) throw new Error(`${r} answered HTTP ${response.status}: ${await response.text()}`);
    return response.json();
  }, [route, init] as const) as Promise<T>;
}

test('the command line in the packaged app answers from the instance, and no console window shows', async () => {
  test.setTimeout(600_000);
  const exe = packagedExecutable();
  if (exe === null) unavailable('no packaged app under resmon_scripts/frontend/release: run `npm run dist` first');
  const folder = appFolder(exe as string);
  const bundled = bundledBackend(exe as string);
  for (const needed of [bundled.python, bundled.archive]) {
    if (!fs.existsSync(needed)) unavailable(`the packaged app has no ${needed}`);
  }

  const stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-cli-')));
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-cli-vault-')));
  let watch: WindowWatch | null = null;
  try {
    const before = snapshotTree(folder);
    const terminal = terminalEnv(stateDir);

    // 1. The version, from the bundled interpreter running the bundled archive.
    const version = await runToEnd(bundled.python, ['-I', bundled.archive, '--version'], terminal);
    console.log('CLI VERSION', JSON.stringify({ status: version.status, stdout: version.stdout.trim(), stderr: version.stderr.trim() }));
    expect(version.status, version.stderr).toBe(0);
    expect(version.stdout.trim()).toBe(`resmon ${CHECKOUT_VERSION} (the command line inside the resmon app: ${folder})`);

    if (process.platform === 'win32') watch = await startWindowWatch();

    // 2. A small corpus, written with the app's own interpreter and sources.
    const env = atlasEnv(launchEnv(stateDir, true));
    delete env.RESMON_PYTHON;
    const seeded = await runToEnd(bundled.python, ['-c', SEED, bundled.scripts], {
      ...terminal, RESMON_DB_PATH: env.RESMON_DB_PATH, PYTHONDONTWRITEBYTECODE: '1',
      PYTHON_KEYRING_BACKEND: 'keyring.backends.null.Keyring',
    });
    expect(seeded.status, seeded.stderr).toBe(0);

    // 3. The packaged app, launched against the isolated instance.
    const app = await electron.launch({
      executablePath: exe as string,
      args: [`--user-data-dir=${path.join(stateDir, 'electron-user-data')}`],
      env,
      timeout: 180_000,
    });
    try {
      const win = await app.firstWindow({ timeout: 180_000 });
      await win.waitForLoadState('domcontentloaded');
      await win.locator(ATLAS_LANDMARK).waitFor({ state: 'visible', timeout: 120_000 });
      const port = await win.evaluate(
        () => (window as unknown as { resmonAPI: { getBackendPort(): string } }).resmonAPI.getBackendPort(),
      );
      expect(port).not.toBe('8742');

      // 4. The command line reaches this instance, found from the state folder alone.
      const status = await runToEnd(bundled.python, ['-I', bundled.archive, 'service', 'status', '--json'], terminal);
      console.log('CLI SERVICE STATUS', status.status, status.stdout.slice(0, 600));
      expect(status.status, status.stderr).toBe(0);
      const answered = JSON.parse(status.stdout) as { running: boolean; reached: { how: string; port: number; state_dir: string } };
      expect(answered.running).toBe(true);
      expect(answered.reached.port).toBe(Number(port));
      expect(answered.reached.how).toBe('app');
      expect(fs.realpathSync(answered.reached.state_dir)).toBe(stateDir);

      const today = await runToEnd(bundled.python, ['-I', bundled.archive, 'today', '--json'], terminal);
      expect(today.status, today.stderr).toBe(0);
      expect(JSON.parse(today.stdout)).toHaveProperty('window');
      const wall = await runToEnd(bundled.python, ['-I', bundled.archive, 'wall', '--json'], terminal);
      expect(wall.status, wall.stderr).toBe(0);
      expect(typeof JSON.parse(wall.stdout)).toBe('object');

      // 5. The engine starts a map fit in a child process...
      await expect.poll(async () => (await engine<{ state: string }>(win, '/api/map')).state,
        { timeout: 180_000, intervals: [500] }).toBe('ready');

      // ...and a PDF worker, to read the one page of a retained file.
      const library = await engine<{ vault: { vault_id: string } }>(win, '/api/library/vault',
        { method: 'POST', json: { parent_directory: scratch } });
      const vault = library.vault.vault_id;
      const pdf = writePdf([{ lines: [{ x: 72, y: 720, size: 14, text: 'A page for the PDF worker to read.' }] }]);
      const imported = await engine<{ file: { file_id: string; version_id: string } }>(
        win, `/api/library/files?expected_vault_id=${vault}&filename=worker.pdf`, { method: 'POST', bytes: [...pdf] });
      const { file_id: fileId, version_id: versionId } = imported.file;
      const route = `/api/library/files/${fileId}/shared-wording`;
      await engine(win, route, { method: 'POST', json: { expected_vault_id: vault, expected_version_id: versionId } });
      await expect.poll(
        async () => (await engine<{ state: string }>(win, `${route}?expected_vault_id=${vault}&expected_version_id=${versionId}`)).state,
        { timeout: 120_000, intervals: [500] },
      ).toBe('done');

      // 6. A unit written by this engine, which the packaged app started, runs the app. (Written
      // to this instance's own unit folder and never registered. On Linux the unit runs the engine:
      // a systemd user unit has no display, which the app needs.)
      const unit = await engine<{ unit_path: string }>(win, '/api/service/install',
        { method: 'POST', json: { register: false } });
      expect(unit.unit_path.startsWith(stateDir)).toBe(true);
      const unitText = fs.readFileSync(unit.unit_path, 'utf8');
      if (process.platform === 'linux') {
        expect(unitText).toContain('implementation_scripts.daemon');
      } else {
        expect(unitText).toContain(exe as string);
        expect(unitText).toContain('--service');
        expect(unitText).not.toContain('implementation_scripts.daemon');
      }
    } finally {
      await app.close().catch(() => { /* already gone */ });
    }

    // 7. No console window at any point, and nothing written into the app.
    if (watch) {
      const seen = await watch.stop();
      watch = null;
      console.log(`WINDOWS SEEN (${seen.length})\n${describeWindows(seen)}`);
      const consoles = consoleWindowsShown(seen, folder);
      expect(consoles, `a console window appeared:\n${describeWindows(consoles)}`).toEqual([]);
    }
    const changes = changesBetween(before, snapshotTree(folder));
    console.log('APP FOLDER CHANGES', JSON.stringify(changes));
    expect(changes, 'the app wrote into its own folder').toEqual([]);
  } finally {
    await watch?.stop().catch(() => undefined);
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

/**
 * The menu items, in the packaged app, writing into a folder of this test's own
 * (`RESMON_COMMAND_LINE_ROOT`) rather than the machine's /usr/local/bin or home:
 * install, run what was written, and uninstall. Windows is left out because its
 * install edits the registry, which a folder cannot redirect.
 */
test('Install and Uninstall "resmon" Command write a launcher that runs the app\'s command line', async () => {
  test.skip(process.platform === 'win32', 'the Windows install edits the registry');
  test.setTimeout(300_000);
  const exe = packagedExecutable();
  if (exe === null) unavailable('no packaged app under resmon_scripts/frontend/release: run `npm run dist` first');
  const folder = appFolder(exe as string);
  const stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-cli-menu-')));
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-cli-root-')));
  const launcher = process.platform === 'darwin'
    ? path.join(root, 'bin', 'resmon')
    : path.join(root, '.local', 'bin', 'resmon');
  const env = atlasEnv(launchEnv(stateDir, true));
  delete env.RESMON_PYTHON;
  env.RESMON_COMMAND_LINE_ROOT = root;
  const before = snapshotTree(folder);

  const app = await electron.launch({
    executablePath: exe as string,
    args: [`--user-data-dir=${path.join(stateDir, 'electron-user-data')}`],
    env,
    timeout: 180_000,
  });
  const output: string[] = [];
  app.process().stdout?.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  const answered = async (action: 'install' | 'uninstall') => {
    await expect.poll(() => output.join('').includes(`[main] command line {"action":"${action}"`),
      { timeout: 60_000 }).toBe(true);
    const line = output.join('').split('\n').filter((l) => l.startsWith('[main] command line '))
      .map((l) => JSON.parse(l.slice('[main] command line '.length)) as { action: string; ok: boolean; message: string })
      .find((r) => r.action === action);
    return line as { action: string; ok: boolean; message: string };
  };
  const click = (id: string) => app.evaluate(async ({ Menu }, itemId) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(itemId);
    if (!item) throw new Error(`no menu item ${itemId}`);
    item.click();
    return true;
  }, id);

  try {
    const win = await app.firstWindow({ timeout: 180_000 });
    await win.locator(ATLAS_LANDMARK).waitFor({ state: 'visible', timeout: 120_000 });

    await click('install-command');
    const installed = await answered('install');
    console.log('INSTALL', JSON.stringify(installed));
    expect(installed.ok).toBe(true);
    expect(fs.existsSync(launcher)).toBe(true);

    // What a terminal does: run the launcher. It needs nothing of this suite's environment.
    const run = await runToEnd(launcher, ['--version'], terminalEnv(stateDir));
    console.log('LAUNCHER', JSON.stringify(run));
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout.trim()).toBe(
      process.platform === 'darwin'
        ? `resmon ${CHECKOUT_VERSION} (the command line inside the resmon app: ${folder})`
        // On Linux the launcher runs the copy kept in the user's data folder.
        : `resmon ${CHECKOUT_VERSION} (the resmon app's command line: ${path.join(root, '.local', 'share', 'resmon', 'resmon.pyz')})`,
    );

    await click('uninstall-command');
    const removed = await answered('uninstall');
    expect(removed.ok).toBe(true);
    expect(fs.existsSync(launcher)).toBe(false);
  } finally {
    await app.close().catch(() => { /* already gone */ });
    expect(changesBetween(before, snapshotTree(folder)), 'the app wrote into its own folder').toEqual([]);
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
