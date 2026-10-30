/**
 * Atlas: Watches and a watch, in the real app.
 *
 * A seeded corpus: three watches, one watching daily at nine and one paused,
 * the first with two runs behind it (the latest with a source that did not
 * answer) and a webhook destination in review mode with one delivery waiting;
 * the third watching, saved as the earlier interface saved some, with no
 * words and last May's two days as its window. Followed through what a person
 * does with them: read the list and the month ahead, open a watch from a mark
 * on the month, open the watch, run the paused one now, pause and resume,
 * flip a switch and see it kept, write an intent and see the audit compare
 * against it, and skip the waiting delivery.
 *
 * Nothing runs a watch on schedule here: the window's own engine runs no
 * scheduler and this state directory has no background service. So no
 * watching watch may be said to run "next"; each says when it is due and that
 * nothing will run it, with the way to Settings › In the background.
 *
 * The journeys J03, J11, J20, J39 and J40 drive the same screens through
 * `journeys/drivers/atlas.ts`; this spec is the part that runs on every pull
 * request. No network: the run asks a source that needs a key, which the
 * suite's empty keyring does not have, so it is skipped at once.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test, expect, _electron as electron } from '@playwright/test';
import { FRONTEND_ROOT, SCREENSHOT_DIR, launchEnv, registerStateDir } from './fixtures/resmon-app';

const SEED = String.raw`
import json, os, sys
from datetime import datetime, timedelta, timezone
sys.path.insert(0, sys.argv[1])
from implementation_scripts.database import (init_db, get_connection, insert_document, insert_routine,
    insert_execution, link_execution_document, record_execution_source, update_execution_status)
from implementation_scripts import delivery
path = os.environ["RESMON_DB_PATH"]
init_db(path)
conn = get_connection(path)
now = datetime.now(timezone.utc)
iso = lambda t: t.strftime("%Y-%m-%dT%H:%M:%SZ")
docs = [insert_document(conn, {
    "source_repository": "arxiv", "external_id": f"watch-{n}", "title": f"Perovskite film stability, part {n}",
    "authors": "Ada Fixture", "publication_date": "2026-10-01", "abstract": "An authored abstract.",
    "metadata_hash": f"watch-{n}"}) for n in range(5)]
watching = insert_routine(conn, {"name": "Perovskite films", "schedule_cron": "0 9 * * *", "is_active": 1,
    "parameters": json.dumps({"repositories": ["springer", "arxiv"], "keywords": ["perovskite"], "query": "perovskite"})})
paused = insert_routine(conn, {"name": "Quiet watch", "schedule_cron": "30 7 * * 1", "is_active": 0,
    "parameters": json.dumps({"repositories": ["springer"], "keywords": ["quiet"], "query": "quiet"})})
# As the earlier interface saved some: no words, and a fixed window that ended.
stale = insert_routine(conn, {"name": "Old window", "schedule_cron": "15 6 * * *", "is_active": 1,
    "parameters": json.dumps({"repositories": ["arxiv"], "keywords": [], "query": "",
                              "date_from": "2026-05-03", "date_to": "2026-05-04"})})
target = delivery.add_target(conn, watching, channel="webhook", target="https://resmon-e2e.invalid/hook",
                             mode="review", enabled=True)
runs = []
for night, found, silent in ((2, docs[:3], False), (1, docs[3:], True)):
    start = now - timedelta(days=night)
    run = insert_execution(conn, {"execution_type": "automated_sweep", "routine_id": watching,
        "start_time": iso(start), "parameters": json.dumps({"repositories": ["springer", "arxiv"]})})
    for doc in found:
        link_execution_document(conn, run, doc)
    record_execution_source(conn, run, "arxiv", "ok", result_count=len(found), zero_reason=None)
    record_execution_source(conn, run, "springer", "error" if silent else "ok", result_count=0,
                            zero_reason="upstream_failure" if silent else None)
    update_execution_status(conn, run, "completed", end_time=iso(start + timedelta(seconds=20)),
                            result_count=len(found), new_result_count=len(found))
    runs.append(run)
conn.execute("INSERT INTO deliveries (execution_id, target_id, channel, target_snapshot, state, attempts, queued_at_utc) "
             "VALUES (?, ?, 'webhook', 'https://resmon-e2e.invalid/hook', 'awaiting_review', 0, ?)",
             (runs[-1], target, iso(now)))
conn.execute("UPDATE routines SET last_executed_at = ? WHERE id = ?", (iso(now - timedelta(days=1)), watching))
conn.commit()
print(json.dumps({"watching": watching, "paused": paused, "stale": stale, "runs": runs}))
`;

test('Watches lists each watch and its month ahead; a watch runs, pauses, keeps its switches, and its record', async () => {
  test.setTimeout(240_000);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-watches-'));
  // A unit directory of this run's own, so "is a background service
  // installed?" is answered about this run and not about the machine.
  const units = path.join(stateDir, 'units');
  fs.mkdirSync(units);
  const env: Record<string, string> = { ...launchEnv(stateDir, true), RESMON_UI: 'atlas', RESMON_SERVICE_UNIT_DIR: units };
  const seeded = spawnSync(env.RESMON_PYTHON ?? 'python3', ['-c', SEED, path.join(FRONTEND_ROOT, '..')], { env, encoding: 'utf8' });
  expect(seeded.status, seeded.stderr).toBe(0);
  const { watching, paused, stale, runs } = JSON.parse(seeded.stdout.trim().split('\n').pop() ?? '{}') as
    { watching: number; paused: number; stale: number; runs: number[] };

  const app = await electron.launch({
    args: ['.', `--user-data-dir=${path.join(stateDir, 'electron-user-data')}`],
    cwd: FRONTEND_ROOT, env, colorScheme: null, timeout: 180_000,
  });
  registerStateDir(stateDir);
  try {
    const win = await app.firstWindow({ timeout: 180_000 });
    const problems: string[] = [];
    win.on('pageerror', (e) => problems.push(e.message));
    await win.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'Watches' }).click();
    await expect(win.getByRole('heading', { name: 'Watches', level: 1 })).toBeVisible({ timeout: 60_000 });

    // The list: each watch's state and schedule in words, and no stray zero
    // where a paused watch has no next fire.
    await expect(win.locator('.count-sentence')).toHaveText('3 watches, 2 watching and 1 paused');
    const active = win.locator(`.watch[data-routine="${watching}"]`);
    await expect(active.locator('.watch-state')).toHaveText('Watching');
    await expect(active.locator('.meta').first()).toContainText('Daily at 9:00 AM');
    const quiet = win.locator(`.watch[data-routine="${paused}"]`);
    await expect(quiet.locator('.meta').first()).toHaveText(/^Paused\s*Mondays at 7:30 AM$/);

    // Watching is not running: nothing runs a watch on schedule here, and the
    // list says so once, with the way to the switch that would, and each
    // watching watch says when it is due rather than when it runs next.
    const note = win.locator('.watch-index [data-firing-note]');
    await expect(note).toHaveText('Nothing will run your watches on schedule. This window does not run watches itself, and '
      + 'no background service is set up. Turn on Run resmon in the background in Settings › In the background.', { timeout: 30_000 });
    await expect(note.getByRole('link', { name: 'Settings › In the background' })).toHaveAttribute('href', '#/settings/background');
    await expect(active).toHaveAttribute('data-firing', 'will-not-run');
    await expect(active.locator('.watch-next')).toHaveText(/^due .+, but nothing will run it$/);
    await expect(win.locator('.watch-list')).not.toContainText(/\bnext\b/);
    expect(await quiet.getAttribute('data-firing'), 'a paused watch was given a verdict on firing').toBeNull();

    // The watch the earlier interface saved: no words, and a window that ended.
    const old = win.locator(`.watch[data-routine="${stale}"]`);
    await expect(old.locator('[data-warning="no_terms"]')).toContainText('every run sends its sources an empty query');
    await expect(old.locator('[data-warning="window_ended"]'))
      .toContainText('Every run asks for papers published from May 3, 2026 to May 4, 2026');
    await expect(old.locator('[data-warning="window_ended"]').getByRole('link', { name: 'Change' }))
      .toHaveAttribute('href', `#/watches/${stale}/edit`);
    // Its dates ended, and the cure named is the window that moves, not clearing them.
    await expect(old.locator('[data-warning="window_ended"]'))
      .toContainText('choose “Papers published since the previous run” under Change');
    await expect(old.locator('[data-warning="undated_relevance"]')).toHaveCount(0);
    // No dates on Springer Nature, which ranks by relevance: the same papers every run.
    await expect(active.locator('.watch-warning')).toHaveCount(1);
    await expect(active.locator('[data-warning="undated_relevance"]'))
      .toContainText('Every run asks Springer Nature with no date limit, and it ranks by relevance');

    // The month ahead draws the watching watch's fires at nine, and none of the
    // paused one's; it says they are due, not that they will run.
    const month = win.locator('section.month-ahead');
    await expect(month).toHaveAttribute('data-state', 'read', { timeout: 30_000 });
    await expect(month.locator('.ahead-lede')).toContainText('When each watch is due by its schedule');
    await expect(month.locator('.ahead-lede')).not.toContainText('will run,');
    await expect(month.getByRole('heading', { name: 'Next due', level: 3 })).toBeVisible();
    const fires = month.locator(`.fire[data-routine="${watching}"]`);
    await expect(fires.first()).toBeVisible();
    await expect(fires.first()).toHaveAttribute('data-firing', 'will-not-run');
    const hours = await fires.evaluateAll((marks) => marks.map((m) => new Date(String((m as HTMLElement).dataset.at)).getHours()));
    expect(new Set(hours)).toEqual(new Set([9]));
    await expect(month.locator(`.fire[data-routine="${paused}"]`)).toHaveCount(0);
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-watches.png') });
    await month.scrollIntoViewIfNeeded();
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-watches-month.png') });

    // A mark opens its watch, by the pointer and by the keyboard: the marks are
    // one stop, the arrows move through them in time order, Enter opens one.
    await month.locator('.fire-mark').filter({ has: win.locator(`.fire[data-routine="${watching}"]`) }).first().click();
    await expect(win.locator(`.watch-page[data-routine="${watching}"]`)).toBeVisible();
    await win.goBack();
    await expect(month).toHaveAttribute('data-state', 'read', { timeout: 30_000 });
    const marks = month.locator('.fire-mark');
    await expect(month.locator('.fire-mark[tabindex="0"]')).toHaveCount(1);
    await marks.first().focus();
    await win.keyboard.press('ArrowRight');
    await expect(marks.nth(1)).toBeFocused();
    await expect(marks.nth(1)).toHaveAttribute('tabindex', '0');
    const second = await marks.nth(1).locator('.fire').getAttribute('data-routine');
    await win.keyboard.press('Enter');
    await expect(win.locator(`.watch-page[data-routine="${second}"]`)).toBeVisible();
    await win.goBack();
    await expect(win.getByRole('heading', { name: 'Watches', level: 1 })).toBeVisible();

    // The watch: its runs, latest first, and the source that did not answer by name.
    await active.locator('.watch-name').click();
    const page = win.locator(`.watch-page[data-routine="${watching}"]`);
    await expect(page).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Runs', level: 2 })).toBeVisible();
    await expect(page.locator('.night')).toHaveCount(2);
    await expect(page.locator('.night').first()).toHaveAttribute('data-run', String(runs[1]));
    await expect(page.locator('.night').first().locator('.night-silent')).toHaveText('Springer Nature did not answer');
    await expect(page.locator('.night-scale')).toContainText('Papers new in each run, oldest at the left; the tallest bar is 3 papers.');

    // Its own page says when it is due, that nothing will run it, and why.
    await expect(page.locator('.run-meta .watch-next')).toHaveText(/^due .+, but nothing will run it$/);
    await expect(page.locator('.run-head [data-firing-note]')).toContainText('Nothing will run this watch on schedule.');
    await win.getByRole('tab', { name: 'Schedule' }).click();
    await expect(page.getByRole('heading', { name: 'When it is due', level: 3 })).toBeVisible();
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-watch-due.png') });
    await win.getByRole('tab', { name: 'What it finds' }).click();

    // A switch flipped is kept, through a visit elsewhere and back.
    const notify = page.locator('[data-switch="notify_on_complete"]');
    await expect(notify).toHaveAttribute('aria-checked', 'false');
    await notify.click();
    await expect(notify).toHaveAttribute('aria-checked', 'true');
    await win.evaluate(() => { window.location.hash = '#/today'; });
    await win.evaluate((id) => { window.location.hash = `#/watches/${id}`; }, watching);
    await expect(win.locator(`.watch-page[data-routine="${watching}"]`)).toHaveAttribute('aria-busy', 'false');
    await expect(win.locator('[data-switch="notify_on_complete"]')).toHaveAttribute('aria-checked', 'true');

    // Pause and resume change the schedule and not the watch.
    await win.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect(page).toHaveAttribute('data-active', 'false');
    await expect(page.locator('.run-meta .watch-state')).toHaveText('Paused');
    await win.getByRole('button', { name: 'Resume', exact: true }).click();
    await expect(page).toHaveAttribute('data-active', 'true');

    // What it finds: the keywords stand in, and the panel says that is circular,
    // until an intent is written; then it compares against that.
    const intent = page.locator('[data-coverage="intent"]');
    await expect(intent).toContainText('Comparing against');
    await expect(intent).toContainText('results the query produced');
    await expect(page.locator('[data-coverage="cannot-see"]')).toContainText('only compare against papers it already holds');
    await win.getByLabel('What this watch is really looking for').fill('Perovskite films that keep their efficiency.');
    await page.locator('.intent-form').getByRole('button', { name: 'Save' }).click();
    await expect(intent).toContainText('the intent written for this watch', { timeout: 30_000 });
    await expect(intent).not.toContainText('results the query produced');

    // Where reports go: the delivery waiting for a person, skipped.
    await win.getByRole('tab', { name: 'Where reports go' }).click();
    const held = page.locator('.delivery-row[data-state="awaiting_review"]');
    await expect(held.locator('.delivery-state')).toHaveText('Waiting for you');
    await held.getByRole('button', { name: 'Skip' }).click();
    await expect(page.locator('.delivery-row').first()).toHaveAttribute('data-state', 'skipped');
    await expect(page.locator('.delivery-row').first().locator('.delivery-state')).toHaveText('Skipped');
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-watch.png') });

    // The paused watch runs now, once, and the engine's sentence says it is not scheduled.
    await win.evaluate((id) => { window.location.hash = `#/watches/${id}`; }, paused);
    const quietPage = win.locator(`.watch-page[data-routine="${paused}"]`);
    await expect(quietPage).toBeVisible();
    await expect(quietPage.locator('.night-list')).toHaveCount(1);
    await win.getByRole('button', { name: 'Run now', exact: true }).click();
    const said = quietPage.locator('.run-now-said');
    await expect(said).toContainText('This routine is not scheduled; it was run once because you asked for it.');
    await expect(quietPage.locator('.night')).toHaveCount(1, { timeout: 60_000 });
    await expect(quietPage.locator('.night').first()).not.toHaveAttribute('data-status', 'running', { timeout: 60_000 });
    // Its one run brought in nothing new: the strip states no tallest bar,
    // rather than a scale of one paper.
    await expect(quietPage.locator('.night-scale')).toHaveAttribute('data-scale', 'none');
    await expect(quietPage.locator('.night-scale')).not.toContainText('tallest bar');
    // A paused watch is not said to be due, and its page carries no note about the service.
    await expect(quietPage.locator('[data-firing-note]')).toHaveCount(0);

    // The watch saved with no words and an ended window says so on its own
    // page, with the way to change it; nothing stored is changed by reading it.
    await win.evaluate((id) => { window.location.hash = `#/watches/${id}`; }, stale);
    const stalePage = win.locator(`.watch-page[data-routine="${stale}"]`);
    await expect(stalePage.locator('[data-warning="no_terms"]')).toBeVisible();
    await expect(stalePage.locator('.run-meta')).toContainText('no words in arXiv');
    await expect(stalePage.locator('[data-warning="window_ended"]')).toContainText('that window ended on May 4, 2026');
    await expect(stalePage.locator('[data-watch="window"]')).toHaveAttribute('data-window', 'between');
    await expect(stalePage.locator('[data-watch="window"]'))
      .toContainText('Every run asks for papers published from May 3, 2026 to May 4, 2026, the same dates each time.');
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-watch-warnings.png') });
    await stalePage.locator('[data-warning="window_ended"]').getByRole('link', { name: 'Change' }).click();
    await expect(win.locator('.watch-editor')).toBeVisible();
    expect(win.url().endsWith(`#/watches/${stale}/edit`), win.url()).toBe(true);

    expect(problems).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
