/**
 * The reading queue in the real application.
 *
 * One Electron process, its own Python backend on a port it chose, over an
 * authored synthetic database seeded by `test_reading_queue.py`'s CLI modes.
 * No provider or model is called, port 8742 is never bound, and the corpus the
 * user actually has is never opened.
 *
 * What only this level can establish: that a real click in the packagedable app
 * reaches the real backend, that the state a user sees afterwards is the state
 * SQLite holds, and that the default page of 50 is really crossed — the run
 * here has 51 papers because an off-by-one in a pager is invisible at exactly
 * 50 and a paper nobody can reach is the failure that matters.
 *
 * What it still cannot see is in the handback: a human-operated native save
 * dialog. `will-download` below replaces the destination picker and nothing
 * else — the request, the renderer, the serializer and the bytes are the
 * product's.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { FRONTEND_ROOT, launchEnv, ensureScreenshotDir } from './fixtures/resmon-app';

const HELPER = path.resolve(FRONTEND_ROOT, '../verification_scripts/test_reading_queue.py');

interface Fixture {
  big_run_id: number;
  rediscovery_run_id: number;
  empty_run_id: number;
  big_document_ids: number[];
  twin_document_ids: number[];
  shared_document_id: number;
  big_run_size: number;
  record_count: number;
  marker: string;
}

/** Open the run viewer on a given execution and switch to a tab. */
async function openRun(win: Page, execId: number, tab: string): Promise<void> {
  await win.evaluate((h) => { window.location.hash = h; }, `#/results?exec=${execId}&tab=${tab}`);
  await win.reload();
  await win.locator('.app-main').waitFor({ state: 'visible', timeout: 60_000 });
}

test('a paper saved from a run is the paper the queue holds, in the real app', async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-reading-queue-'));
  const env = launchEnv(state, true);
  env.RESMON_DISABLE_SCHEDULER = '1';
  env.PYTHON_KEYRING_BACKEND = 'keyring.backends.null.Keyring';

  const fixture: Fixture = JSON.parse(
    execFileSync(env.RESMON_PYTHON, [HELPER, 'seed', env.RESMON_DB_PATH], { env, encoding: 'utf8' }),
  );
  const snapshot = () => execFileSync(
    env.RESMON_PYTHON, [HELPER, 'snapshot', env.RESMON_DB_PATH], { env, encoding: 'utf8' });
  const before = snapshot();
  const shots = ensureScreenshotDir();

  const app: ElectronApplication = await electron.launch({
    args: ['.', `--user-data-dir=${path.join(state, 'electron-user-data')}`],
    cwd: FRONTEND_ROOT, env, timeout: 180_000,
  });
  try {
    const win = await app.firstWindow({ timeout: 180_000 });
    await win.locator('.app-main').waitFor({ state: 'visible', timeout: 60_000 });

    const port = await win.evaluate(
      () => (window as unknown as { resmonAPI: { getBackendPort(): string } }).resmonAPI.getBackendPort());
    expect(port).not.toBe('8742');
    const base = `http://127.0.0.1:${port}`;
    const health = await (await win.request.get(`${base}/api/health`)).json();
    expect(Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(health.pid)],
      { encoding: 'utf8' }).trim())).toBe(app.process().pid);
    console.log('READING_QUEUE_INSTANCE', JSON.stringify({
      state, port, health, parentPid: app.process().pid,
      fixture: { records: fixture.record_count, bigRun: fixture.big_run_size } }));

    /* ---------------------------------------------------------------- */
    /* The queue starts empty, and says where papers come from.          */
    /* ---------------------------------------------------------------- */
    await win.getByRole('link', { name: 'Reading queue' }).click();
    await expect(win.getByTestId('queue-empty')).toContainText('Nothing saved yet');
    await win.screenshot({ path: path.join(shots, '30-reading-queue-empty.png') });

    /* ---------------------------------------------------------------- */
    /* Results parity, then the Papers tab and its paging.               */
    /* ---------------------------------------------------------------- */
    await win.getByRole('link', { name: 'Results & Logs' }).click();
    for (const label of ['Export Selected (0)', 'BibTeX', 'RIS', 'CSV', 'Delete Selected (0)']) {
      await expect(win.getByRole('button', { name: label, exact: true })).toBeVisible();
    }

    await openRun(win, fixture.big_run_id, 'papers');
    for (const tab of ['Report', 'Log', 'Metadata', 'Progress', 'Search record', 'Papers']) {
      await expect(win.getByRole('button', { name: tab, exact: true })).toBeVisible();
    }
    await expect(win.getByTestId('papers-range'))
      .toHaveText(`Papers 1–50 of ${fixture.big_run_size}`);
    // Every paper in the run carries the same publication date, so the order is
    // the id, descending: the newest id opens page one and the oldest is alone
    // on page two. Naming them this way rather than indexing blindly is what
    // makes the pager assertions mean something.
    const ids = fixture.big_document_ids;
    const newestId = ids[ids.length - 1];
    const oldestId = ids[0];
    await expect(win.getByTestId(`paper-${newestId}`)).toBeVisible();
    await expect(win.getByTestId(`paper-${oldestId}`)).toHaveCount(0);

    await win.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(win.getByTestId('papers-range'))
      .toHaveText(`Papers 51–${fixture.big_run_size} of ${fixture.big_run_size}`);
    // The 51st paper is reachable, which is the whole reason the fixture is 51.
    await expect(win.getByTestId(`paper-${oldestId}`)).toBeVisible();
    await win.getByRole('button', { name: 'Previous', exact: true }).click();
    await expect(win.getByTestId('papers-range'))
      .toHaveText(`Papers 1–50 of ${fixture.big_run_size}`);

    /* ---------------------------------------------------------------- */
    /* Save — one real click, and the database afterwards.               */
    /* ---------------------------------------------------------------- */
    await win.getByTestId(`save-${newestId}`).click();
    await expect(win.getByTestId(`saved-${newestId}`)).toHaveText('In queue · To read');
    await win.screenshot({ path: path.join(shots, '31-reading-queue-papers-tab.png') });

    const savedRows = await (await win.request.get(`${base}/api/reading-queue?status=all`)).json();
    expect(savedRows.entries.map((e: { document_id: number }) => e.document_id)).toEqual([newestId]);

    /* An empty run has nothing to save, and says so rather than showing a
       blank list that looks like a failed load. */
    await openRun(win, fixture.empty_run_id, 'papers');
    await expect(win.getByTestId('papers-empty')).toBeVisible();

    /* ---------------------------------------------------------------- */
    /* The queue: state, evidence, filters, keyboard.                    */
    /* ---------------------------------------------------------------- */
    await win.getByRole('link', { name: 'Reading queue' }).click();
    await expect(win.getByTestId('filter-to_read')).toHaveAttribute('aria-pressed', 'true');
    await expect(win.getByTestId(`state-${newestId}`)).toHaveText('To read');

    // The same evidence component the Explorer uses, asked about this paper.
    await win.getByRole('button', { name: 'Why am I seeing this?' }).first().click();
    await expect(win.locator('.why-body').first()).toBeVisible();
    await expect(win.locator('.why-verdict').first()).not.toBeEmpty();
    await win.screenshot({ path: path.join(shots, '32-reading-queue-evidence.png') });

    // Marking it read under the To read filter takes it out of that list —
    // which is what the filter means. The list is re-read from the backend
    // rather than edited in place, so what is on screen is what SQLite holds.
    await win.getByTestId(`toggle-${newestId}`).click();
    await expect(win.getByTestId('queue-empty'))
      .toContainText('Everything you saved has been read');
    const afterRead = await (await win.request.get(`${base}/api/reading-queue?status=read`)).json();
    expect(afterRead.entries[0].document_id).toBe(newestId);
    expect(afterRead.entries[0].read_at).not.toBeNull();

    // Empty *here* is not empty everywhere, and the page says which it means.
    await win.getByTestId('filter-read').click();
    await expect(win.getByTestId(`state-${newestId}`)).toHaveText('Read');

    /* Keyboard: the state control is reachable and operable without a mouse. */
    await win.getByTestId(`toggle-${newestId}`).focus();
    await expect(win.getByTestId(`toggle-${newestId}`)).toBeFocused();
    await win.keyboard.press('Enter');
    await expect(win.getByTestId('queue-empty')).toBeVisible();
    await win.getByTestId('filter-all').click();
    await expect(win.getByTestId(`state-${newestId}`)).toHaveText('To read');
    const afterUnread = await (await win.request.get(`${base}/api/reading-queue?status=all`)).json();
    expect(afterUnread.entries[0].read_at).toBeNull();

    /* ---------------------------------------------------------------- */
    /* Paging the queue itself, over the app's own HTTP surface.         */
    /* ---------------------------------------------------------------- */
    // Saved through the running backend rather than by 51 clicks: the click
    // path is proven above, and what is under test here is the pager.
    for (const id of ids.filter((id) => id !== newestId)) {
      const response = await win.request.post(`${base}/api/reading-queue`, {
        data: { document_id: id },
      });
      expect(response.status()).toBe(201);
    }
    await win.reload();
    await win.locator('.app-main').waitFor({ state: 'visible', timeout: 60_000 });
    await win.getByRole('link', { name: 'Reading queue' }).click();
    await expect(win.getByTestId('queue-range'))
      .toHaveText(`Showing 1–50 of ${fixture.big_run_size}`);
    await win.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(win.getByTestId('queue-range'))
      .toHaveText(`Showing 51–${fixture.big_run_size} of ${fixture.big_run_size}`);
    await win.getByRole('button', { name: 'Previous', exact: true }).click();

    /* ---------------------------------------------------------------- */
    /* Selection is per page, and the export is the selection.           */
    /* ---------------------------------------------------------------- */
    // Two rows from the page actually in view, taken from the DOM rather than
    // predicted: the queue's order is by save time first, and this check is
    // about the selection and the export, not about which paper is where.
    const boxes = win.locator('.reading-item input[type="checkbox"]');
    await boxes.nth(0).check();
    await boxes.nth(1).check();
    await win.screenshot({ path: path.join(shots, '33-reading-queue-selected.png') });

    for (const [label, extension] of [['BibTeX', 'bib'], ['RIS', 'ris'], ['CSV', 'csv']]) {
      const destination = path.join(state, `queue.${extension}`);
      await app.evaluate(({ BrowserWindow }, target) => {
        BrowserWindow.getAllWindows()[0].webContents.session.once(
          'will-download', (_event, item) => { item.setSavePath(target); });
      }, destination);
      await win.getByRole('button', { name: label, exact: true }).click();
      await expect.poll(() => fs.existsSync(destination)).toBe(true);
      const bytes = fs.readFileSync(destination);
      const text = bytes.toString('utf8');
      if (label === 'BibTeX') {
        const keys = [...text.matchAll(/^@\w+\{([^,]+),/gm)].map((m) => m[1]);
        expect(keys).toHaveLength(2);
        expect(new Set(keys).size).toBe(2);
      } else if (label === 'RIS') {
        expect(text.match(/^TY {2}- /gm)).toHaveLength(2);
      } else {
        expect(text.trim().split('\n')).toHaveLength(3);
      }
      console.log('READING_QUEUE_SAVED', JSON.stringify({
        format: label, entries: 2, bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex') }));
    }

    // Moving to another page clears the ticks, so nothing off-screen can be
    // exported: the buttons go back to disabled.
    await win.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(win.getByRole('button', { name: 'BibTeX', exact: true })).toBeDisabled();

    /* ---------------------------------------------------------------- */
    /* A failing request is an error on screen, never a silent success.  */
    /* ---------------------------------------------------------------- */
    await win.route('**/api/reading-queue?*', (route) => route.abort('failed'));
    await win.getByTestId('filter-all').click();
    await expect(win.getByTestId('queue-error')).toBeVisible();
    await expect(win.getByTestId('queue-empty')).toHaveCount(0);
    await win.screenshot({ path: path.join(shots, '34-reading-queue-error.png') });
    await win.unroute('**/api/reading-queue?*');

    /* The corpus and every run's provenance are exactly as seeded. */
    expect(snapshot()).toBe(before);
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(state, { recursive: true, force: true });
  }
});
