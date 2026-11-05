/**
 * Atlas: the whole reading queue as the Library's gallery, in the real app.
 *
 * The engine answers at most 200 entries a request, so a queue of 203 is
 * seeded, as a person who had saved that many would have it: every paper to
 * read, saved in the same second, so the engine's order is the paper's
 * number, newest first, and the last three come from the second request.
 * The gallery draws only the rows near the view, and reads the next 200 as
 * the view nears the end. Then what a person does: scroll to the last three,
 * pick two and export them, mark one read, and take one out. After each, the
 * counts are held to the engine's own, and what the export wrote is read back
 * from the file.
 *
 * The journey J28 drives a queue of two through `journeys/drivers/atlas.ts`;
 * this spec is the part that crosses a request. No network is involved.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { FRONTEND_ROOT, SCREENSHOT_DIR, atlasEnv, launchEnv, registerStateDir } from './fixtures/resmon-app';
import { shelfHolds } from './fixtures/gallery';

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

test('the reading queue past its first 200: drawn near the view, read as it is scrolled, picked, exported, marked, taken out', async () => {
  test.setTimeout(240_000);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-queue-'));
  const env = atlasEnv({ ...launchEnv(stateDir, true) });
  const seeded = spawnSync(env.RESMON_PYTHON ?? 'python3', ['-c', SEED, path.join(FRONTEND_ROOT, '..'), String(SIZE)], { env, encoding: 'utf8' });
  expect(seeded.status, seeded.stderr).toBe(0);
  const { ids } = JSON.parse(seeded.stdout.trim().split('\n').pop() ?? '{}') as { ids: number[] };
  expect(ids).toHaveLength(SIZE);
  // Newest first, and the same second for all: the highest number leads, the three lowest come last.
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
    await expect(win.getByRole('heading', { name: 'Library', level: 1 })).toBeVisible({ timeout: 60_000 });
    const show = win.getByRole('group', { name: 'Show' });
    const cards = win.locator('article.card');
    const card = (id: number) => win.locator(`article.card[data-document="${id}"]`);
    const engineCounts = async () => (await api<QueuePage>(win, '/api/reading-queue?status=all&limit=1')).counts;

    // — drawn near the view, every one of them reachable -----------------------------
    await expect(show.getByRole('button', { name: /^To read/ })).toContainText('203', { timeout: 30_000 });
    await expect(card(ids[SIZE - 1]!)).toBeVisible({ timeout: 30_000 });
    const drawn = await cards.count();
    expect(drawn, 'the gallery drew every card rather than the rows near the view').toBeLessThan(60);
    // The list says each card's place in the whole, so a screen reader hears 203, not the few drawn.
    await expect(win.locator('.gal-cell').first()).toHaveAttribute('aria-setsize', '203');
    const stage = win.locator('main.stage');
    for (let i = 0; i < 40 && !(await card(first).count()); i += 1) {
      await stage.evaluate((node) => { node.scrollTop = node.scrollHeight; });
      await win.waitForTimeout(150);
    }
    await expect(card(first)).toBeVisible({ timeout: 30_000 });
    await expect(card(first).locator('..')).toHaveAttribute('aria-posinset', '203');

    // — two picked, exported: the file holds those two and no other ----------------------
    // Select is at the top; the view goes back down to the last three, which the gallery draws again.
    await win.getByRole('button', { name: 'Select', exact: true }).click();
    await stage.evaluate((node) => { node.scrollTop = node.scrollHeight; });
    await card(third).locator('.thumb').click();
    await card(second).locator('.thumb').click();
    const bar = win.getByRole('group', { name: 'The picked cards' });
    await expect(bar).toContainText('2 of 203 picked');
    const ris = path.join(stateDir, 'queue-picked.ris');
    await app.evaluate(({ BrowserWindow }, target) => {
      BrowserWindow.getAllWindows()[0].webContents.session.once('will-download', (_e, item) => {
        item.setSavePath(target as string);
      });
    }, ris);
    await bar.getByRole('group', { name: 'Export the picked papers' }).getByRole('button', { name: 'RIS', exact: true }).click();
    await expect.poll(() => (fs.existsSync(ris) ? fs.statSync(ris).size : 0), { timeout: 30_000 }).toBeGreaterThan(0);
    const exported = fs.readFileSync(ris, 'utf8');
    expect(exported.match(/^TY {2}- /gm) ?? []).toHaveLength(2);
    expect(exported).toContain('Queued paper 003');
    expect(exported).toContain('Queued paper 002');
    expect(exported).not.toContain('Queued paper 001');
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-reading-queue-end.png') });
    await bar.getByRole('button', { name: 'Done' }).click();
    await stage.evaluate((node) => { node.scrollTop = node.scrollHeight; });

    // — one marked read leaves To read, and the counts go with it -------------------------
    await card(second).getByRole('button', { name: 'Mark read' }).click();
    await expect(card(second)).toHaveCount(0, { timeout: 30_000 });
    await expect(show.getByRole('button', { name: /^Read/ })).toContainText('1');
    await expect(show.getByRole('button', { name: /^To read/ })).toContainText('202');
    expect(await engineCounts()).toEqual({ to_read: 202, read: 1, all: 203 });

    // — one taken out: the paper stays in the collection -------------------------------
    await card(third).hover();
    await card(third).getByRole('button', { name: 'Remove from To read' }).click();
    await expect(card(third)).toHaveCount(0, { timeout: 30_000 });
    expect(await engineCounts()).toEqual({ to_read: 201, read: 1, all: 202 });
    expect((await api<{ id: number }>(win, `/api/documents/${third}`)).id, 'Remove deleted the paper').toBe(third);

    // — Read holds the one marked read ------------------------------------------------
    await show.getByRole('button', { name: /^Read/ }).click();
    await shelfHolds(win, 1);
    await expect(card(second)).toBeVisible();

    expect(problems).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
