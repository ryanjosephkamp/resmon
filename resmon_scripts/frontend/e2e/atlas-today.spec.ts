/**
 * Atlas's Today, in the real app, over a small collection written for it: the
 * plate draws, the index lists exactly the papers new since the last look
 * with numbers matching the plate's, a watch names the source that did not
 * answer on its last run, and Mark all read starts the next window, as the
 * engine then reports too.
 *
 * The collection is written through the engine's own database functions
 * before launch, so the counts asserted here are the ones it was given.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test, expect, _electron as electron } from '@playwright/test';
import { launchEnv, registerStateDir, FRONTEND_ROOT, SCREENSHOT_DIR } from './fixtures/resmon-app';

const SEED = String.raw`
import json, os, sys
from datetime import datetime, timedelta, timezone
sys.path.insert(0, sys.argv[1])
from implementation_scripts.database import (init_db, get_connection, insert_document, insert_routine,
    insert_execution, link_execution_document, record_execution_source, update_execution_status, set_setting)

TOPICS = {
    "protein": "protein folding residue amino chain conformation binding structure",
    "traffic": "traffic congestion road sensor commute intersection vehicle flow",
    "quantum": "quantum qubit circuit entanglement gate decoherence photon error",
}
now = datetime.now(timezone.utc)
fmt = lambda t: t.strftime("%Y-%m-%d %H:%M:%S")
path = os.environ["RESMON_DB_PATH"]
init_db(path)
conn = get_connection(path)
ids = {t: {"new": [], "old": []} for t in TOPICS}
for topic, words in TOPICS.items():
    w = words.split()
    for n in range(14):
        fresh = n < 3
        doc = insert_document(conn, {
            "source_repository": "arxiv", "external_id": f"{topic}-{n}",
            "title": f"{w[0].title()} {w[n % len(w)]} {w[(n + 3) % len(w)]} study {n}",
            "authors": "Ada Lovelace, Alan Turing",
            "abstract": " ".join(w[(n + k) % len(w)] for k in range(30)) + ". A second sentence follows.",
            "metadata_hash": f"{topic}-{n}",
        })
        seen = now - (timedelta(hours=2 + n) if fresh else timedelta(days=10 + 7 * n))
        conn.execute("UPDATE documents SET first_seen_at = ? WHERE id = ?", (fmt(seen), doc))
        ids[topic]["new" if fresh else "old"].append(doc)
conn.commit()

routine = insert_routine(conn, {"name": "Protein structure", "schedule_cron": "0 2 * * *",
    "parameters": json.dumps({"repositories": ["arxiv", "dblp"], "query": "protein"}), "is_active": 1})
def run(routine_id, docs, started, sources, kind="automated_sweep"):
    e = insert_execution(conn, {"execution_type": kind, "routine_id": routine_id,
        "parameters": json.dumps({"repositories": list(sources)}), "start_time": fmt(started)})
    for d in docs:
        link_execution_document(conn, e, d)
    for source, (status, count, reason) in sources.items():
        record_execution_source(conn, e, source, status, result_count=count, zero_reason=reason)
    update_execution_status(conn, e, "completed", end_time=fmt(started + timedelta(seconds=41)),
        result_count=len(docs), new_result_count=len(docs))
run(routine, ids["protein"]["old"], now - timedelta(days=30), {"arxiv": ("ok", 11, None), "dblp": ("ok", 3, None)})
run(routine, ids["protein"]["new"], now - timedelta(hours=2), {"arxiv": ("ok", 3, None), "dblp": ("ok", 0, "upstream_failure")})
run(None, ids["traffic"]["new"], now - timedelta(hours=3), {"arxiv": ("ok", 3, None)}, kind="deep_sweep")
# The last look is yesterday at noon on this machine's clock, which the heading
# words as "yesterday". It was 20 hours ago, which is yesterday only before
# 20:00: from then until midnight the heading read "New since today" and the
# case failed, on CI's UTC runners every evening from 20:00 UTC.
local = datetime.now().astimezone()
looked = local.replace(hour=12, minute=0, second=0, microsecond=0) - timedelta(days=1)
set_setting(conn, "today_looked_at", fmt(looked.astimezone(timezone.utc)))
conn.commit()
print(json.dumps({"new": sum(len(v["new"]) for v in ids.values()), "watch_new": len(ids["protein"]["new"])}))
`;

test('Today lists what is new since the last look, and Mark all read starts the next window', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-today-'));
  const env: Record<string, string> = { ...launchEnv(stateDir, true), RESMON_UI: 'atlas' };
  const seeded = spawnSync(env.RESMON_PYTHON ?? 'python3', ['-c', SEED, path.join(FRONTEND_ROOT, '..')],
    { env, encoding: 'utf8' });
  expect(seeded.status, seeded.stderr).toBe(0);
  const counts = JSON.parse(seeded.stdout.trim().split('\n').pop() ?? '{}') as { new: number; watch_new: number };

  const app = await electron.launch({
    args: ['.', `--user-data-dir=${path.join(stateDir, 'electron-user-data')}`],
    cwd: FRONTEND_ROOT, env, colorScheme: null, timeout: 180_000,
  });
  registerStateDir(stateDir);
  try {
    const win = await app.firstWindow({ timeout: 180_000 });
    const problems: string[] = [];
    win.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
    win.on('pageerror', (e) => problems.push(e.message));

    // The plate draws once the map is fitted; the index lists the new papers.
    await expect(win.locator('.plate-canvas')).toBeVisible({ timeout: 120_000 });
    await expect.poll(() => win.locator('.plate-canvas').evaluate((c) => (c as HTMLCanvasElement).dataset.frameMs ?? ''))
      .not.toBe('');
    const heading = win.getByRole('heading', { name: /^New since yesterday/ });
    await expect(heading).toContainText(String(counts.new));
    await expect(win.getByRole('heading', { name: `${counts.new} new papers` })).toBeVisible();

    // One entry per new paper, numbered 1 to N in the order they arrived.
    const badges = win.locator('.entry .badge');
    await expect(badges).toHaveCount(counts.new);
    const numbers = (await badges.allTextContents()).map(Number).sort((a, b) => a - b);
    expect(numbers).toEqual(Array.from({ length: counts.new }, (_, i) => i + 1));

    // The watch, its count, and the source that did not answer, by name.
    const watch = win.getByRole('region', { name: 'Protein structure' });
    await expect(watch.locator('.ghead .n')).toHaveText(`${counts.watch_new} new`);
    await expect(watch.getByRole('note')).toContainText('DBLP');
    await expect(win.getByRole('region', { name: 'From your own searches' })).toBeVisible();

    // Choosing a paper selects it in the index.
    const first = win.locator('.entry-title').first();
    await first.click();
    await expect(first).toHaveAttribute('aria-pressed', 'true');

    // The opening has lit every number by now.
    await expect(win.locator('.entry .badge.dim')).toHaveCount(0);
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-today.png') });

    // Mark all read: the next window starts now, here and in the engine.
    await win.getByRole('button', { name: 'Mark all read' }).click();
    await expect(win.getByText('Nothing new since then.')).toBeVisible();
    const port = await win.evaluate(() => (window as unknown as { resmonAPI: { getBackendPort: () => string } }).resmonAPI.getBackendPort());
    const engine = await (await e2eFetch(`http://127.0.0.1:${port}/api/today`)).json() as { window: string; total: number };
    expect(engine).toMatchObject({ window: 'since_last_look', total: 0 });

    expect(problems, 'the page reported errors').toEqual([]);
  } finally {
    await app.close().catch(() => { /* already gone */ });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
