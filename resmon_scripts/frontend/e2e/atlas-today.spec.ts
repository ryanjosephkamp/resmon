/**
 * Atlas's Today, in the real app, over a small collection written for it: the
 * plate draws, the index lists exactly the papers new since the last look
 * with numbers matching the plate's, a watch names the sources that did not
 * answer on its last run in one line (a withdrawn one by its name, not its
 * key) with each one's reason a click away, coming back to Today draws the
 * same answer at rest and the list grouped as it was left, both themes are
 * pictured, and Mark all read starts the next window, as the engine then
 * reports too. Today and the map are kept between visits, a run that ended
 * meanwhile is read in on the next visit rather than at the minute's refresh,
 * and the opening plays for that new answer and not on a return to the same
 * one.
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
from implementation_scripts.api_registry import RETIRED_REPOSITORIES

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
        # A withdrawn source is recorded as the sweep records it, with its reason.
        detail = json.dumps({"detail": RETIRED_REPOSITORIES[source]}) if reason == "retired" else None
        record_execution_source(conn, e, source, status, result_count=count, zero_reason=reason, zero_detail=detail)
    update_execution_status(conn, e, "completed", end_time=fmt(started + timedelta(seconds=41)),
        result_count=len(docs), new_result_count=len(docs))
run(routine, ids["protein"]["old"], now - timedelta(days=30), {"arxiv": ("ok", 11, None), "dblp": ("ok", 3, None)})
run(routine, ids["protein"]["new"], now - timedelta(hours=2), {"arxiv": ("ok", 3, None), "dblp": ("ok", 0, "upstream_failure"),
    "ieee": ("error", 0, "retired")})
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

    // The watch, its count, and the sources that did not answer, in one line
    // by name: a withdrawn source by the name it had, never by its key. Each
    // one's reason is a click away, in place, with the way to the whole run.
    const watch = win.getByRole('region', { name: 'Protein structure' });
    await expect(watch.locator('.ghead .n')).toHaveText(`${counts.watch_new} new`);
    const trouble = watch.getByRole('note');
    await expect(trouble.locator('.trouble-line')).toContainText('DBLP did not answer');
    await expect(trouble.locator('.trouble-line')).toContainText('IEEE Xplore was withdrawn');
    await expect(trouble.locator('.trouble-part[data-category="non_answer"]')).toHaveCount(2);
    expect(await trouble.innerText()).not.toMatch(/\bieee\b/);
    await expect(trouble.locator('.trouble-notes')).toHaveCount(0);
    await trouble.getByRole('button', { name: 'Why' }).click();
    await expect(trouble.locator('.trouble-notes li[data-source="ieee"]')).toContainText('IEEE Xplore was withdrawn in v1.8.1');
    await expect(trouble.locator('.trouble-notes li[data-source="dblp"]')).toContainText('DBLP');
    await expect(trouble.getByRole('link', { name: /^Open run \d+$/ })).toBeVisible();
    await trouble.getByRole('button', { name: 'Hide why' }).click();
    await expect(trouble.locator('.trouble-notes')).toHaveCount(0);
    await expect(win.getByRole('region', { name: 'From your own searches' })).toBeVisible();

    // Choosing a paper selects it in the index.
    const first = win.locator('.entry-title').first();
    await first.click();
    await expect(first).toHaveAttribute('aria-pressed', 'true');

    // The opening has lit every number by now.
    await expect(win.locator('.entry .badge.dim')).toHaveCount(0);
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-today.png') });

    // Coming back to Today draws the same answer at rest, with no number dim.
    // The list is grouped as it was left, and the engine keeps that.
    const byRegion = win.getByRole('group', { name: 'Group by' }).getByRole('button', { name: 'By region' });
    await byRegion.click();
    await expect(byRegion).toHaveAttribute('aria-pressed', 'true');
    const sections = win.getByRole('navigation', { name: 'Sections' });
    await sections.getByRole('link', { name: 'Watches' }).click();
    await expect(win.getByRole('heading', { name: 'Watches', level: 1 })).toBeVisible();
    await sections.getByRole('link', { name: 'Today' }).click();
    await expect(win.locator('.entry .badge')).toHaveCount(counts.new);
    await expect(win.locator('.entry .badge.dim')).toHaveCount(0, { timeout: 10_000 });
    await expect(byRegion).toHaveAttribute('aria-pressed', 'true');
    const port = await win.evaluate(() => (window as unknown as { resmonAPI: { getBackendPort: () => string } }).resmonAPI.getBackendPort());
    const kept = await (await e2eFetch(`http://127.0.0.1:${port}/api/map/views/today`)).json() as { list_by: string };
    expect(kept.list_by).toBe('region');
    await win.getByRole('group', { name: 'Group by' }).getByRole('button', { name: 'By watch' }).click();

    // The other theme, pictured for review: the night chart.
    const theme = await win.evaluate(() => document.documentElement.dataset.theme);
    const other = theme === 'dark' ? 'The printed atlas' : 'The night chart';
    await win.getByRole('link', { name: 'Settings', exact: true }).click();
    await win.locator('.theme-card', { hasText: other }).click();
    await expect.poll(() => win.evaluate(() => document.documentElement.dataset.theme)).not.toBe(theme);
    await sections.getByRole('link', { name: 'Today' }).click();
    await expect(win.locator('.plate-canvas')).toBeVisible({ timeout: 60_000 });
    await expect(win.locator('.entry .badge.dim')).toHaveCount(0, { timeout: 10_000 });
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, `atlas-today-${theme === 'dark' ? 'light' : 'dark'}.png`) });

    // Mark all read: the next window starts now, here and in the engine.
    await win.getByRole('button', { name: 'Mark all read' }).click();
    await expect(win.getByText('Nothing new since then.')).toBeVisible();
    const engine = await (await e2eFetch(`http://127.0.0.1:${port}/api/today`)).json() as { window: string; total: number };
    expect(engine).toMatchObject({ window: 'since_last_look', total: 0 });

    expect(problems, 'the page reported errors').toEqual([]);
  } finally {
    await app.close().catch(() => { /* already gone */ });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

/** A run that ends while the window is elsewhere, as one the background service runs: two papers new now. */
const FINISH = String.raw`
import json, os, sys
from datetime import datetime, timedelta, timezone
sys.path.insert(0, sys.argv[1])
from implementation_scripts.database import (get_connection, insert_document, insert_execution,
    link_execution_document, update_execution_status)
now = datetime.now(timezone.utc)
fmt = lambda t: t.strftime("%Y-%m-%d %H:%M:%S")
conn = get_connection(os.environ["RESMON_DB_PATH"])
docs = []
for n in range(2):
    doc = insert_document(conn, {"source_repository": "arxiv", "external_id": f"late-{n}",
        "title": f"Protein folding late arrival {n}", "authors": "Grace Hopper",
        "abstract": "protein folding residue chain binding structure " * 6, "metadata_hash": f"late-{n}"})
    conn.execute("UPDATE documents SET first_seen_at = ? WHERE id = ?", (fmt(now), doc))
    docs.append(doc)
e = insert_execution(conn, {"execution_type": "deep_sweep", "parameters": json.dumps({"repositories": ["arxiv"]}),
    "start_time": fmt(now - timedelta(seconds=30))})
for d in docs:
    link_execution_document(conn, e, d)
update_execution_status(conn, e, "completed", end_time=fmt(now), result_count=2, new_result_count=2)
conn.commit()
print(json.dumps({"run": e, "papers": len(docs)}))
`;

test('Today is kept between visits: the same answer is drawn at rest, and a new one is read in and played', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-today-kept-'));
  const env: Record<string, string> = { ...launchEnv(stateDir, true), RESMON_UI: 'atlas' };
  const seeded = spawnSync(env.RESMON_PYTHON ?? 'python3', ['-c', SEED, path.join(FRONTEND_ROOT, '..')],
    { env, encoding: 'utf8' });
  expect(seeded.status, seeded.stderr).toBe(0);
  const counts = JSON.parse(seeded.stdout.trim().split('\n').pop() ?? '{}') as { new: number };

  const app = await electron.launch({
    args: ['.', `--user-data-dir=${path.join(stateDir, 'electron-user-data')}`],
    cwd: FRONTEND_ROOT, env, colorScheme: null, timeout: 180_000,
  });
  registerStateDir(stateDir);
  try {
    const win = await app.firstWindow({ timeout: 180_000 });
    const reads: { path: string; at: number }[] = [];
    win.on('request', (request) => {
      const { pathname } = new URL(request.url());
      if (pathname === '/api/today' || pathname === '/api/map') reads.push({ path: pathname, at: Date.now() });
    });
    const sections = win.getByRole('navigation', { name: 'Sections' });
    const away = async () => {
      await sections.getByRole('link', { name: 'Watches' }).click();
      await expect(win.getByRole('heading', { name: 'Watches', level: 1 })).toBeVisible();
    };
    const back = async () => {
      await sections.getByRole('link', { name: 'Today' }).click();
      await expect(win.locator('.plate-canvas')).toBeVisible({ timeout: 30_000 });
    };

    // The opening lights each number by an animation of its own: counted here.
    const lit = () => win.evaluate(() => (window as unknown as { e2eLit: number }).e2eLit);
    await win.evaluate(() => {
      const counted = window as unknown as { e2eLit: number };
      counted.e2eLit = 0;
      const animate = Element.prototype.animate;
      Element.prototype.animate = function (...args: Parameters<Element['animate']>) {
        if (this.classList.contains('badge')) counted.e2eLit += 1;
        return animate.apply(this, args);
      };
    });

    // The first visit reads both, once the map is fitted, and plays the opening.
    await expect(win.locator('.plate-canvas')).toBeVisible({ timeout: 120_000 });
    await expect(win.getByRole('heading', { name: `${counts.new} new papers` })).toBeVisible();
    await expect.poll(lit, { message: 'the first visit played no opening' }).toBeGreaterThan(0);
    await expect(win.locator('.entry .badge.dim')).toHaveCount(0, { timeout: 10_000 });

    // Away and back: Today and the map are drawn from what was read, neither is
    // asked for again, and the same answer is drawn at rest, with no opening.
    const kept = reads.length;
    await away();
    const playedBefore = await lit();
    await back();
    await expect(win.locator('.entry .badge')).toHaveCount(counts.new);
    await expect(win.locator('.entry .badge.dim')).toHaveCount(0);
    await expect.poll(() => win.locator('.plate-canvas').evaluate((c) => (c as HTMLCanvasElement).dataset.frameMs ?? ''))
      .not.toBe('');
    expect(reads.slice(kept), 'a revisit read Today or the map again').toEqual([]);
    expect(await lit(), 'a return to the same answer played the opening again').toBe(playedBefore);

    // A run ends while the window is elsewhere. The next visit reads it in at
    // once, well inside the minute after which Today is read again anyway.
    await away();
    const finished = spawnSync(env.RESMON_PYTHON ?? 'python3', ['-c', FINISH, path.join(FRONTEND_ROOT, '..')],
      { env, encoding: 'utf8' });
    expect(finished.status, finished.stderr).toBe(0);
    const lastRead = Math.max(...reads.filter((r) => r.path === '/api/today').map((r) => r.at));
    await back();
    await expect(win.getByRole('heading', { name: `${counts.new + 2} new papers` })).toBeVisible({ timeout: 10_000 });
    await expect(win.locator('.entry-title', { hasText: 'Protein folding late arrival 0' })).toBeVisible();
    // A new answer: the opening plays for it.
    await expect.poll(lit, { message: 'the new answer played no opening' }).toBeGreaterThan(playedBefore);
    const reread = reads.filter((r) => r.at > lastRead);
    expect(reread.map((r) => r.path)).toEqual(expect.arrayContaining(['/api/today', '/api/map']));
    expect(Math.min(...reread.map((r) => r.at)) - lastRead, 'read in by the minute\'s refresh, not by the run ending')
      .toBeLessThan(60_000);
  } finally {
    await app.close().catch(() => { /* already gone */ });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

/** Sixty papers new from a person's own search, the last to arrive findable by its author. */
const MANY = String.raw`
import json, os, sys
from datetime import datetime, timedelta, timezone
sys.path.insert(0, sys.argv[1])
from implementation_scripts.database import (init_db, get_connection, insert_document, insert_execution,
    link_execution_document, update_execution_status, set_setting)
now = datetime.now(timezone.utc)
fmt = lambda t: t.strftime("%Y-%m-%d %H:%M:%S")
path = os.environ["RESMON_DB_PATH"]
init_db(path)
conn = get_connection(path)
words = "protein folding residue amino chain conformation binding structure".split()
docs = []
for n in range(60):
    title = f"{words[n % 8].title()} {words[(n + 3) % 8]} study {n}"
    doc = insert_document(conn, {"source_repository": "arxiv", "external_id": f"many-{n}", "title": title,
        "authors": "Grace Hopper" if n == 59 else "Ada Lovelace", "abstract": " ".join(words[(n + k) % 8] for k in range(30)) + ".",
        "metadata_hash": f"many-{n}"})
    # Written in the order they arrived, which is the order Today numbers them.
    conn.execute("UPDATE documents SET first_seen_at = ? WHERE id = ?", (fmt(now - timedelta(minutes=120 - n)), doc))
    docs.append(doc)
e = insert_execution(conn, {"execution_type": "deep_sweep", "parameters": json.dumps({"repositories": ["arxiv"]}),
    "start_time": fmt(now - timedelta(hours=3))})
for d in docs:
    link_execution_document(conn, e, d)
update_execution_status(conn, e, "completed", end_time=fmt(now - timedelta(hours=2)), result_count=60, new_result_count=60)
set_setting(conn, "today_looked_at", fmt(now - timedelta(days=1)))
conn.commit()
`;

test('Today lists a group\'s first papers, more on request, and any paper chosen on the plate', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-today-many-'));
  const env: Record<string, string> = { ...launchEnv(stateDir, true), RESMON_UI: 'atlas' };
  const seeded = spawnSync(env.RESMON_PYTHON ?? 'python3', ['-c', MANY, path.join(FRONTEND_ROOT, '..')],
    { env, encoding: 'utf8' });
  expect(seeded.status, seeded.stderr).toBe(0);
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${path.join(stateDir, 'electron-user-data')}`],
    cwd: FRONTEND_ROOT, env, colorScheme: null, timeout: 180_000,
  });
  registerStateDir(stateDir);
  try {
    const win = await app.firstWindow({ timeout: 180_000 });
    await expect(win.locator('.plate-canvas')).toBeVisible({ timeout: 120_000 });
    await expect(win.getByRole('heading', { name: '60 new papers' })).toBeVisible();
    const group = win.getByRole('region', { name: 'From your own searches' });
    const entries = group.locator('.entry');
    // The first twenty-five to arrive, in order, and the way to the next ones.
    await expect(entries).toHaveCount(25);
    await expect(entries.first().locator('.badge')).toHaveText('1');
    await expect(entries.last().locator('.badge')).toHaveText('25');
    const more = group.getByRole('button', { name: /^Show 35 more of From your own searches, 35 not listed yet$/ });
    await more.click();
    await expect(entries).toHaveCount(60);
    await expect(group.getByRole('button', { name: /^Show \d+ more/ })).toHaveCount(0);
    // The caret is on the first paper it listed, so the keyboard goes on from there.
    await expect(entries.nth(25).locator('.entry-title')).toBeFocused();

    // Back again, the group starts from its first twenty-five; a paper found on
    // the plate is listed and chosen however far down it is.
    const sections = win.getByRole('navigation', { name: 'Sections' });
    await sections.getByRole('link', { name: 'Watches' }).click();
    await expect(win.getByRole('heading', { name: 'Watches', level: 1 })).toBeVisible();
    await sections.getByRole('link', { name: 'Today' }).click();
    await expect(entries).toHaveCount(25);
    const find = win.getByPlaceholder('Find a title or author');
    await find.fill('Hopper');
    // One match, counted once the engine has answered.
    await expect(win.locator('.map-find-at')).toHaveText('1', { timeout: 10_000 });
    await find.press('Enter');
    const chosen = group.locator('.entry.sel');
    await expect(chosen).toHaveCount(1, { timeout: 10_000 });
    await expect(chosen.locator('.who')).toHaveText('Grace Hopper');
    await expect(chosen.locator('.badge')).toHaveText('60');
    await expect(entries).toHaveCount(60);
  } finally {
    await app.close().catch(() => { /* already gone */ });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
