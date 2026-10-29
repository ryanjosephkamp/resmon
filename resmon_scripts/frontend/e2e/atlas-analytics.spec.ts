/**
 * Atlas: Health › Analytics, and Search › Your collection narrowed by it, in
 * the real app.
 *
 * A seeded collection over two sources, with dates and categories, and one
 * watch with three completed runs, so every view has something to draw and
 * none is below its threshold except where the seed says so. Each figure is
 * held to what the engine served, not to a number written here. Then the
 * handoff: a source's row and a category's total each open the collection
 * narrowed to it, the filter named on the screen and removable.
 *
 * J05 drives the same screens through `journeys/drivers/atlas.ts`; this spec
 * is the part that runs on every pull request. No network.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { FRONTEND_ROOT, SCREENSHOT_DIR, launchEnv, registerStateDir } from './fixtures/resmon-app';

const SEED = String.raw`
import json, os, sys
from datetime import datetime, timedelta, timezone
sys.path.insert(0, sys.argv[1])
from implementation_scripts.database import (init_db, get_connection, insert_document, insert_routine,
    insert_execution, update_execution_status)
path = os.environ["RESMON_DB_PATH"]
init_db(path)
conn = get_connection(path)
now = datetime.now(timezone.utc)
iso = lambda t: t.strftime("%Y-%m-%dT%H:%M:%SZ")
docs = []
for n in range(8):
    source = "arxiv" if n < 5 else "crossref"
    docs.append(insert_document(conn, {
        "source_repository": source, "external_id": f"analytics-{n}", "title": f"Perovskite stability, paper {n}",
        "authors": "Ada Fixture; Ben Example", "abstract": "Perovskite tandem cells held outdoors.",
        "publication_date": (now - timedelta(days=10 + n * 20)).strftime("%Y-%m-%d"),
        "categories": "cond-mat.mtrl-sci, physics.app-ph" if n % 2 else "cond-mat.mtrl-sci",
        "doi": f"10.1000/analytics.{n}" if n < 4 else None, "metadata_hash": f"analytics-{n}"}))
watch = insert_routine(conn, {"name": "Perovskite films", "schedule_cron": "0 9 * * *", "is_active": 0,
    "parameters": json.dumps({"repositories": ["arxiv"], "keywords": ["perovskite"], "query": "perovskite"})})
for night, new in ((3, 4), (2, 0), (1, 1)):
    start = now - timedelta(days=night)
    run = insert_execution(conn, {"execution_type": "automated_sweep", "routine_id": watch, "start_time": iso(start),
        "parameters": json.dumps({"repositories": ["arxiv"], "keywords": ["perovskite"], "query": "perovskite"})})
    update_execution_status(conn, run, "completed", end_time=iso(start + timedelta(seconds=20)),
                            result_count=5, new_result_count=new)
conn.commit()
print(json.dumps({"watch": watch, "docs": docs}))
`;

async function api<T>(win: Page, route: string): Promise<T> {
  return win.evaluate(async (r) => {
    const port = (window as unknown as { resmonAPI: { getBackendPort(): string } }).resmonAPI.getBackendPort();
    const res = await e2eFetch(`http://127.0.0.1:${port}${r}`, { method: 'GET' });
    return await res.json() as unknown;
  }, route) as Promise<T>;
}

interface Overview {
  summary: { documents: number; sources: number; distinct_authors: number; doi_coverage: number | null };
  source_contribution: { sufficient: boolean; sources: { source: string; total: number; unique_papers: number }[] };
  routine_health: { routines: { routine_id: number; status: string; runs: number }[] };
}

test('Analytics draws the engine\'s numbers, and a chart opens the collection narrowed to what it drew', async () => {
  test.setTimeout(240_000);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-analytics-'));
  const env: Record<string, string> = { ...launchEnv(stateDir, true), RESMON_UI: 'atlas' };
  const seeded = spawnSync(env.RESMON_PYTHON ?? 'python3', ['-c', SEED, path.join(FRONTEND_ROOT, '..')], { env, encoding: 'utf8' });
  expect(seeded.status, seeded.stderr).toBe(0);
  const { watch } = JSON.parse(seeded.stdout.trim().split('\n').pop() ?? '{}') as { watch: number };

  const app = await electron.launch({
    args: ['.', `--user-data-dir=${path.join(stateDir, 'electron-user-data')}`],
    cwd: FRONTEND_ROOT, env, colorScheme: null, timeout: 180_000,
  });
  registerStateDir(stateDir);
  try {
    const win = await app.firstWindow({ timeout: 180_000 });
    const problems: string[] = [];
    win.on('pageerror', (e) => problems.push(e.message));
    await win.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'Health' }).click();
    await win.getByRole('navigation', { name: 'Health' }).getByRole('link', { name: 'Analytics' }).click();

    const served = await api<Overview>(win, '/api/analytics/overview');
    const tile = (label: string) => win.locator(`[data-analytics="corpus"] .tile[data-tile="${label}"] dd`);
    await expect(tile('Papers')).toHaveText(String(served.summary.documents), { timeout: 60_000 });
    await expect(tile('Sources used')).toHaveText(String(served.summary.sources));
    await expect(tile('Authors')).toHaveText(String(served.summary.distinct_authors));
    await expect(tile('DOI coverage')).toHaveText(`${Math.round((served.summary.doi_coverage ?? 0) * 100)}%`);

    // Two sources can be compared, so the overlap is drawn, with its key.
    expect(served.source_contribution.sufficient).toBe(true);
    const sources = win.locator('[data-analytics="sources"]');
    await expect(sources.locator('.chart-key li')).toHaveText(['Only from this source', 'Also from another']);
    for (const row of served.source_contribution.sources) {
      await expect(sources.locator(`.bar-row[data-source="${row.source}"] .bar-figure`)).toHaveAttribute('data-value', String(row.total));
    }

    // The watch with three completed runs is judged, with the count it rests on.
    const judged = served.routine_health.routines.find((r) => r.routine_id === watch);
    expect(judged?.runs).toBe(3);
    await expect(win.locator(`.watch-health li[data-routine="${watch}"]`)).toHaveAttribute('data-status', String(judged?.status));
    await expect(win.locator(`.watch-health li[data-routine="${watch}"] .run-tick`)).toHaveCount(3);

    // The keyword view waits to be asked.
    const keywords = win.locator('[data-analytics="keywords"]');
    await expect(keywords).toContainText('does not run automatically');
    await expect(keywords.locator('[data-analytics="keyword-rows"] li')).toHaveCount(0);
    await keywords.locator('[data-analytics="measure"]').click();
    await expect(keywords.locator('[data-analytics="keyword-rows"] li[data-keyword="perovskite"]')).toBeVisible({ timeout: 60_000 });
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-analytics.png') });

    // — the handoff: a source -------------------------------------------------------
    await sources.locator('.bar-row[data-source="crossref"] a.bar-name').click();
    await expect(win.getByRole('heading', { name: 'Your collection', level: 1 })).toBeVisible({ timeout: 30_000 });
    expect(await win.evaluate(() => window.location.hash)).toBe('#/search?source=crossref');
    const crossrefTotal = served.source_contribution.sources.find((s) => s.source === 'crossref')?.total ?? -1;
    await expect(win.locator('.count-sentence')).toHaveText(`${crossrefTotal} papers matching your filters`, { timeout: 30_000 });
    await expect(win.locator('[data-filter="source"]')).toContainText('From CrossRef');
    await expect(win.locator('.result')).toHaveCount(crossrefTotal);
    await win.locator('[data-filter="source"] button').click();
    await expect(win.locator('.count-sentence')).toHaveText(`${served.summary.documents} papers in your collection`, { timeout: 30_000 });
    await expect(win.locator('[data-collection="filters"]')).toHaveCount(0);

    // — the handoff: a category -----------------------------------------------------
    await win.goBack();
    await win.goBack();
    await expect(win.locator('[data-analytics="volume"]')).toBeVisible({ timeout: 30_000 });
    await win.locator('[data-analytics="volume"]').getByRole('button', { name: 'Category' }).click();
    const category = win.locator('[data-analytics="volume"] .group-totals a', { hasText: 'physics.app-ph' });
    await expect(category).toBeVisible({ timeout: 30_000 });
    await category.click();
    expect(await win.evaluate(() => window.location.hash)).toBe('#/search?category=physics.app-ph');
    await expect(win.locator('[data-filter="category"]')).toContainText('In physics.app-ph');
    await expect(win.locator('.count-sentence')).toHaveText('4 papers matching your filters', { timeout: 30_000 });

    expect(problems).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
