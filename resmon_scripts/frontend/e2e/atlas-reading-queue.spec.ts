/**
 * Atlas: the whole reading queue, a page at a time, in the real app.
 *
 * The engine answers at most 200 entries a request, so a queue of 203 is
 * seeded, as a person who had saved that many would have it: every paper to
 * read, saved in the same second, so the engine's order is the paper's
 * number, newest first, and the last three are alone on page two. Then what a
 * person does: page to them with Next, tick two and export them, mark one
 * read, take one out, and mark the last one read, which leaves page two with
 * nothing on it. After each, the screen's range and counts are held to the
 * engine's own, and what the export wrote is read back from the file.
 *
 * The journey J28 drives a queue of two through `journeys/drivers/atlas.ts`;
 * this spec is the part that crosses a page. No network is involved.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { FRONTEND_ROOT, SCREENSHOT_DIR, launchEnv, registerStateDir } from './fixtures/resmon-app';

const SIZE = 203;

/** 203 papers, all in the queue to read, saved in the same second; written in one transaction. */
const SEED = String.raw`
import json, os, sys
sys.path.insert(0, sys.argv[1])
from implementation_scripts.database import init_db, get_connection
path = os.environ["RESMON_DB_PATH"]
init_db(path)
conn = get_connection(path)
size = int(sys.argv[2])
conn.executemany(
    "INSERT INTO documents (source_repository, external_id, title, authors, abstract, publication_date, metadata_hash) "
    "VALUES ('arxiv', ?, ?, 'Ada Fixture', 'An authored abstract for the suite, not a published one.', '2026-10-01', ?)",
    [(f"e2e-queue-{n}", f"Queued paper {n:03d}", f"e2e-queue-{n}") for n in range(1, size + 1)],
)
ids = [row[0] for row in conn.execute("SELECT id FROM documents ORDER BY id")]
conn.executemany(
    "INSERT INTO reading_queue (document_id, status, saved_at, updated_at) VALUES (?, 'to_read', '2026-10-28 09:00:00', '2026-10-28 09:00:00')",
    [(i,) for i in ids],
)
conn.commit()
print(json.dumps({"ids": ids}))
`;

interface QueuePage { total: number; offset: number; entries: { document_id: number; status: string }[]; counts: Record<string, number> }

async function api<T>(win: Page, route: string, method = 'GET'): Promise<T> {
  return win.evaluate(async ([r, m]) => {
    const port = (window as unknown as { resmonAPI: { getBackendPort(): string } }).resmonAPI.getBackendPort();
    const res = await e2eFetch(`http://127.0.0.1:${port}${r}`, { method: m as string });
    if (!res.ok) throw new Error(`${r} answered HTTP ${res.status}: ${await res.text()}`);
    return res.json();
  }, [route, method] as const) as Promise<T>;
}

test('the reading queue past its first page: paging, ticks, export, and a page that empties', async () => {
  test.setTimeout(240_000);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-queue-'));
  const env: Record<string, string> = { ...launchEnv(stateDir, true), RESMON_UI: 'atlas' };
  const seeded = spawnSync(env.RESMON_PYTHON ?? 'python3', ['-c', SEED, path.join(FRONTEND_ROOT, '..'), String(SIZE)], { env, encoding: 'utf8' });
  expect(seeded.status, seeded.stderr).toBe(0);
  const { ids } = JSON.parse(seeded.stdout.trim().split('\n').pop() ?? '{}') as { ids: number[] };
  expect(ids).toHaveLength(SIZE);
  // Newest first, and the same second for all: the highest number leads, the three lowest are on page two.
  const [first, second, third] = ids as [number, number, number];

  const app = await electron.launch({
    args: ['.', `--user-data-dir=${path.join(stateDir, 'electron-user-data')}`],
    cwd: FRONTEND_ROOT, env, colorScheme: null, timeout: 180_000,
  });
  registerStateDir(stateDir);
  try {
    const win = await app.firstWindow({ timeout: 180_000 });
    const problems: string[] = [];
    win.on('pageerror', (e) => problems.push(e.message));
    await win.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'Library' }).click();
    await expect(win.getByRole('heading', { name: 'Reading queue', level: 1 })).toBeVisible({ timeout: 60_000 });
    const queue = win.locator('section.queue');
    const range = win.locator('[data-queue="range"]');
    const rows = win.locator('.queue-row');
    const pager = win.getByRole('navigation', { name: 'Pages of the queue' });
    const show = win.getByRole('group', { name: 'Show' });
    const settled = () => expect(queue).toHaveAttribute('aria-busy', 'false', { timeout: 30_000 });
    const engineCounts = async () => (await api<QueuePage>(win, '/api/reading-queue?status=all&limit=1')).counts;

    // — the first page, and the rest a click away --------------------------------
    await settled();
    // To read / Read / All is the list's own control: at the content's left edge, under the heading, at any width.
    const heading = await win.getByRole('heading', { name: 'Reading queue', level: 1 }).boundingBox();
    const control = await show.boundingBox();
    expect(Math.abs((control?.x ?? 0) - (heading?.x ?? -10))).toBeLessThan(2);
    expect(control?.y ?? 0).toBeGreaterThan(heading?.y ?? 0);
    await expect(range).toHaveText('Papers 1–200 of 203');
    await expect(rows).toHaveCount(200);
    await expect(show.getByRole('button', { name: /^To read/ })).toContainText('203');
    await expect(pager.getByRole('button', { name: 'Previous' })).toBeDisabled();
    await pager.getByRole('button', { name: 'Next' }).click();
    await settled();
    await expect(range).toHaveText('Papers 201–203 of 203');
    await expect(rows).toHaveCount(3);
    expect(await rows.evaluateAll((els) => els.map((el) => Number((el as HTMLElement).dataset.document))))
      .toEqual([third, second, first]);
    await expect(pager.getByRole('button', { name: 'Next' })).toBeDisabled();

    // — two ticked on page two, exported: the file holds those two and no other ------
    const row = (id: number) => win.locator(`.queue-row[data-document="${id}"]`);
    await row(third).getByRole('checkbox').check();
    await row(second).getByRole('checkbox').check();
    const exportBar = win.locator('[data-queue="export"]');
    await expect(exportBar).toContainText('2 papers: export as');
    const ris = path.join(stateDir, 'queue-page-two.ris');
    await app.evaluate(({ BrowserWindow }, target) => {
      BrowserWindow.getAllWindows()[0].webContents.session.once('will-download', (_e, item) => {
        item.setSavePath(target as string);
      });
    }, ris);
    await exportBar.getByRole('button', { name: 'RIS', exact: true }).click();
    await expect.poll(() => (fs.existsSync(ris) ? fs.statSync(ris).size : 0), { timeout: 30_000 }).toBeGreaterThan(0);
    const exported = fs.readFileSync(ris, 'utf8');
    expect(exported.match(/^TY {2}- /gm) ?? []).toHaveLength(2);
    expect(exported).toContain('Queued paper 003');
    expect(exported).toContain('Queued paper 002');
    expect(exported).not.toContain('Queued paper 001');
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-reading-queue-page-two.png') });

    // — one marked read leaves To read, and the tick and the count go with it ---------
    await row(second).getByRole('button', { name: 'Mark read' }).click();
    await expect(row(second)).toHaveCount(0, { timeout: 30_000 });
    await expect(range).toHaveText('Papers 201–202 of 202');
    await expect(exportBar).toContainText('1 paper: export as');
    await expect(show.getByRole('button', { name: /^Read/ })).toContainText('1');
    expect(await engineCounts()).toEqual({ to_read: 202, read: 1, all: 203 });

    // — one taken out: the paper stays in the collection -------------------------------
    await row(third).getByRole('button', { name: 'Remove' }).click();
    await expect(row(third)).toHaveCount(0, { timeout: 30_000 });
    await expect(range).toHaveText('Papers 201–201 of 201');
    await expect(exportBar).toHaveCount(0);
    expect(await engineCounts()).toEqual({ to_read: 201, read: 1, all: 202 });
    expect((await api<{ id: number }>(win, `/api/documents/${third}`)).id, 'Remove deleted the paper').toBe(third);

    // — the last one on page two marked read: the queue moves to the page there is, -----
    // and 200 fit on one page, so there is no pager. Every range drawn on the way is
    // recorded: page one as it was first read ("of 203") is not true any longer, and
    // must not be shown while the page is read again.
    await win.evaluate(() => {
      const drawn: string[] = [];
      (window as unknown as { ranges: string[] }).ranges = drawn;
      new MutationObserver(() => {
        const range = document.querySelector('[data-queue="range"]');
        if (range?.textContent && drawn[drawn.length - 1] !== range.textContent) drawn.push(range.textContent);
      }).observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    await row(first).getByRole('button', { name: 'Mark read' }).click();
    await expect(show.getByRole('button', { name: /^To read/ })).toContainText('200', { timeout: 30_000 });
    await expect(rows).toHaveCount(200);
    await expect(row(ids[SIZE - 1]!)).toBeVisible();
    await expect(pager).toHaveCount(0);
    await expect(win.locator('.queue-empty')).toHaveCount(0);
    // The only range drawn is the one on screen when Mark read was pressed.
    const drawn = await win.evaluate(() => (window as unknown as { ranges: string[] }).ranges);
    expect(drawn.filter((r) => r !== 'Papers 201–201 of 201'), 'a page read before the change was drawn').toEqual([]);
    expect(await engineCounts()).toEqual({ to_read: 200, read: 2, all: 202 });

    // — Read fits on one page, so there is no pager; All has two, and a tick stays on its page --
    await show.getByRole('button', { name: /^Read/ }).click();
    await settled();
    await expect(rows).toHaveCount(2);
    await expect(pager).toHaveCount(0);
    await show.getByRole('button', { name: /^All/ }).click();
    await settled();
    await expect(range).toHaveText('Papers 1–200 of 202');
    await rows.first().getByRole('checkbox').check();
    await expect(exportBar).toContainText('1 paper: export as');
    await pager.getByRole('button', { name: 'Next' }).click();
    await settled();
    await expect(range).toHaveText('Papers 201–202 of 202');
    await expect(exportBar).toHaveCount(0);
    await expect(win.locator('.queue-row input:checked')).toHaveCount(0);

    expect(problems).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
