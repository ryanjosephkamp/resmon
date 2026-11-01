/**
 * Atlas: Health, in the real app. The Source wall, the watchdog, and the
 * engine this window is talking to.
 *
 * A seeded record of four sweeps, so every state the wall draws is on it:
 * arXiv answers, answers with nothing, and has one run with no row (not
 * recorded); CrossRef answers and then fails three runs in a row (broken, to
 * the watchdog); Springer Nature is left out of three runs (not asked) and
 * could not be asked in the fourth (no key); bioRxiv is answered in part on the
 * last three, resmon's budget stopping each read (advice, to the watchdog, and
 * no alarm); and IEEE Xplore, long withdrawn, is still selected by the last
 * three, as an old watch's runs are.
 * Each screen is held to what the engine served for it, rather than to numbers
 * written here.
 *
 * The journeys J06, J30 and J45 drive the same screens through
 * `journeys/drivers/atlas.ts`; this spec is the part that runs on every pull
 * request. No network: nothing here asks a source.
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
from implementation_scripts.database import (init_db, get_connection, insert_execution, record_execution_source,
    update_execution_status)
from implementation_scripts.api_registry import RETIRED_REPOSITORIES
path = os.environ["RESMON_DB_PATH"]
init_db(path)
conn = get_connection(path)
now = datetime.now(timezone.utc)
iso = lambda t: t.strftime("%Y-%m-%dT%H:%M:%SZ")
plan = [
    # (days ago, selection, {source: (status, count, zero_reason)}; a selected source with no entry has no row)
    (4, ["arxiv", "crossref"], {"arxiv": ("ok", 5, None), "crossref": ("ok", 3, None)}),
    (3, ["arxiv", "crossref", "ieee", "biorxiv"], {"arxiv": ("ok", 0, "answered_empty"),
        "crossref": ("error", 0, "upstream_failure"), "ieee": ("error", 0, "retired"),
        "biorxiv": ("ok", 0, "answered_in_part")}),
    (2, ["arxiv", "crossref", "ieee", "biorxiv"], {"crossref": ("error", 0, "upstream_failure"),
        "ieee": ("error", 0, "retired"), "biorxiv": ("ok", 2, "answered_in_part")}),
    (1, ["arxiv", "crossref", "springer", "ieee", "biorxiv"], {"arxiv": ("ok", 4, None),
        "crossref": ("error", 0, "upstream_failure"), "springer": ("skipped_missing_key", 0, "missing_key"),
        "ieee": ("error", 0, "retired"), "biorxiv": ("ok", 0, "answered_in_part")}),
]
# What bioRxiv's client records when resmon's own time budget stops it after the newest pages.
in_part = lambda count, day: json.dumps({"detail": "budget", "attempts": 24, "read": {
    "records": 660, "order": "newest_first", "total": 1824, "first_date": f"2026-10-{day:02d}",
    "last_date": f"2026-10-{day + 2:02d}"}, **({"partial": True, "returned": count} if count else {})})
runs = []
for days, selection, outcomes in plan:
    start = now - timedelta(days=days)
    run = insert_execution(conn, {"execution_type": "deep_sweep", "start_time": iso(start),
        "parameters": json.dumps({"repositories": selection, "keywords": ["perovskite"], "query": "perovskite"})})
    for source, (status, count, reason) in outcomes.items():
        # A withdrawn source is recorded as the sweep records it: the registry's refusal, with its reason.
        retired = RETIRED_REPOSITORIES.get(source) if reason == "retired" else None
        detail = (json.dumps({"detail": retired}) if retired
                  else in_part(count, 28 - days) if reason == "answered_in_part" else None)
        record_execution_source(conn, run, source, status, result_count=count, zero_reason=reason,
            error_message=f"{source} is no longer available. {retired}" if retired else None,
            zero_detail=detail)
    update_execution_status(conn, run, "completed", end_time=iso(start + timedelta(seconds=30)),
                            result_count=sum(c for _s, c, _r in outcomes.values()), new_result_count=0)
    runs.append(run)
conn.commit()
print(json.dumps({"runs": runs}))
`;

type Json = Record<string, unknown>;

async function api<T = Json>(win: Page, route: string, method = 'GET', body?: unknown): Promise<T> {
  return win.evaluate(async ([m, r, b]) => {
    const port = (window as unknown as { resmonAPI: { getBackendPort(): string } }).resmonAPI.getBackendPort();
    const res = await e2eFetch(`http://127.0.0.1:${port}${r}`, {
      method: m, headers: { 'Content-Type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b),
    });
    return await res.json() as unknown;
  }, [method, route, body] as const) as Promise<T>;
}

interface ServedWall {
  verdict: { level: string; headline: string };
  sources: { slug: string; name: string; cells: { state: string; label: string; note: string }[] }[];
  state_legend: { state: string; label: string }[];
  totals: Record<string, number>;
}

test('Health: the Source wall draws what each source did, the watchdog judges it, and the engine names itself', async () => {
  test.setTimeout(240_000);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-health-'));
  const env: Record<string, string> = { ...launchEnv(stateDir, true), RESMON_UI: 'atlas' };
  const seeded = spawnSync(env.RESMON_PYTHON ?? 'python3', ['-c', SEED, path.join(FRONTEND_ROOT, '..')], { env, encoding: 'utf8' });
  expect(seeded.status, seeded.stderr).toBe(0);
  const { runs } = JSON.parse(seeded.stdout.trim().split('\n').pop() ?? '{}') as { runs: number[] };

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

    // — the Source wall ----------------------------------------------------------
    const served = await api<ServedWall>(win, '/api/coverage/source-wall?limit=12');
    const verdict = win.locator('[data-health="verdict"]');
    await expect(verdict.locator('.wall-headline')).toHaveText(served.verdict.headline, { timeout: 60_000 });
    expect(served.verdict.level).toBe('attention');
    await expect(verdict).toHaveAttribute('data-level', 'attention');
    await expect(win.locator('[data-health="window"]')).toHaveText('Showing 4 of 4 recorded runs');
    await expect(win.locator('th.wall-run')).toHaveCount(4);

    // The key: the engine's words, a mark per state, and the totals it served.
    const legend = win.locator('[data-health="legend"] li');
    await expect(legend.locator('.wall-legend-name')).toHaveText(served.state_legend.map((e) => e.label));
    const marks = await legend.locator('svg.wall-mark').evaluateAll((svgs) => svgs.map((s) => s.getAttribute('data-mark')));
    expect(new Set(marks).size, `two states share a mark: ${JSON.stringify(marks)}`).toBe(served.state_legend.length);
    for (const entry of served.state_legend) {
      await expect(win.locator(`[data-health="legend"] li[data-state="${entry.state}"] .wall-legend-count`))
        .toHaveText(String(served.totals[entry.state] ?? 0));
    }

    // Every cell is the state it was served, and the six seeded states are all on it.
    const rows = win.locator('table.wall-grid tbody tr');
    await expect(rows.locator('th[scope="row"]')).toHaveText(served.sources.map((s) => s.name));
    for (const [index, source] of served.sources.entries()) {
      const drawn = await rows.nth(index).locator('button[data-health="cell"]')
        .evaluateAll((cells) => cells.map((c) => c.getAttribute('data-state')));
      expect(drawn, `${source.name} is drawn differently from its record`).toEqual(source.cells.map((c) => c.state));
    }
    const states = new Set(served.sources.flatMap((s) => s.cells.map((c) => c.state)));
    expect([...states].sort()).toEqual(['answered', 'answered_empty', 'answered_in_part', 'could_not_be_asked', 'failed',
      'not_recorded', 'not_selected']);

    // An answer in part, read: its own mark, the engine's words, and its count said as the part read.
    const biorxiv = served.sources.find((s) => s.slug === 'biorxiv');
    expect(biorxiv).toBeTruthy();
    const biorxivRow = rows.filter({ has: win.locator('th[scope="row"]', { hasText: biorxiv!.name }) });
    await expect(biorxivRow.locator('button[data-health="cell"] svg.wall-mark[data-mark="half"]')).toHaveCount(3);
    await biorxivRow.locator('button[data-health="cell"]').nth(3).click();
    const partRead = win.locator('[data-health="reading"]');
    await expect(partRead).toHaveAttribute('data-state', 'answered_in_part');
    await expect(partRead.locator('.wall-reading-label')).toHaveText('answered in part');
    await expect(partRead.locator('.wall-reading-note')).toHaveText(biorxiv!.cells[3]!.note);
    await expect(partRead.locator('.wall-reading-note')).toContainText('resmon read the newest 660 of the 1,824 records');
    await expect(partRead.locator('dd').first()).toHaveText('0, from the part of the window read');
    await partRead.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-health-in-part.png') });

    // A failure, read: the engine's sentence, and no count, which would read as "found none".
    const crossref = served.sources.find((s) => s.slug === 'crossref');
    expect(crossref).toBeTruthy();
    const crossrefRow = rows.filter({ has: win.locator('th[scope="row"]', { hasText: crossref!.name }) });
    await crossrefRow.locator('button[data-health="cell"]').nth(3).click();
    const reading = win.locator('[data-health="reading"]');
    await expect(reading.locator('.wall-reading-note')).toHaveText(crossref!.cells[3]!.note);
    await expect(reading.locator('.wall-reading-label')).toHaveText(crossref!.cells[3]!.label);
    await expect(reading).toHaveAttribute('data-state', 'failed');
    await expect(reading.locator('dt', { hasText: 'Papers' })).toHaveCount(0);
    await expect(reading.getByRole('link', { name: `Open run ${runs[3]}` })).toBeVisible();
    // An answer, read, does carry its count.
    const arxivRow = rows.filter({ has: win.locator('th[scope="row"]', { hasText: 'arXiv' }) });
    await arxivRow.locator('button[data-health="cell"]').nth(0).click();
    await expect(reading.locator('dt', { hasText: 'Papers' })).toHaveCount(1);
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-health-wall.png') });

    // The same run's own page: bioRxiv's row is answered, in part, with its own mark and the engine's words.
    await win.evaluate((id) => { window.location.hash = `#/runs/${id}`; }, runs[3]);
    const partRow = win.locator('.recorded-row[data-source="biorxiv"]');
    await expect(partRow).toHaveAttribute('data-in-part', 'true', { timeout: 30_000 });
    await expect(partRow).toHaveAttribute('data-category', 'answered');
    await expect(partRow.locator('.src-label')).toHaveText('answered in part');
    await expect(partRow.locator('.omark.part')).toHaveCount(1);
    await expect(win.locator('[data-coverage-summary]')).toContainText('answered (1 in part)');
    await expect(win.locator('[data-coverage-summary]')).toContainText(
      'bioRxiv answered in part: resmon read the newest 660 of the 1,824 records');
    await win.locator('.run-sources').screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-run-in-part.png') });
    await win.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'Health' }).click();
    await expect(win.locator('[data-health="verdict"] .wall-headline')).toHaveText(served.verdict.headline, { timeout: 30_000 });

    // More runs asked for than there are: the window says how many there were.
    await win.getByRole('group', { name: 'Runs shown' }).getByRole('button', { name: '24' }).click();
    await expect(win.locator('[data-health="window"]')).toHaveText('Showing 4 of 4 recorded runs');

    // — the watchdog -------------------------------------------------------------
    type Report = {
      counts: { alarms: number; broken: number; unusual: number };
      findings: { key: string; title: string; severity: string; scope: Json }[];
    };
    // The headline from the engine's own counts: the seed makes CrossRef broken,
    // and what else the rules find in it (Springer Nature's missing key) is theirs to say.
    const headline = (c: Report['counts']): string => [
      c.broken ? `${c.broken} ${c.broken === 1 ? 'thing is' : 'things are'} broken` : '',
      c.unusual ? `${c.unusual} ${c.unusual === 1 ? 'looks' : 'look'} unusual` : '',
    ].filter(Boolean).join(', and ') + '.';
    const report = await api<Report>(win, '/api/watchdog');
    const broken = report.findings.find((f) => f.severity === 'broken' && f.scope.id === 'crossref');
    expect(broken, 'three failures in a row made no broken finding').toBeTruthy();
    // Three answers in part are not an alarm: advice, in its own words.
    const partly = report.findings.find((f) => f.scope.id === 'biorxiv');
    expect(partly?.severity).toBe('advice');
    expect(report.findings.filter((f) => f.scope.id === 'biorxiv' && f.severity !== 'advice')).toEqual([]);
    await expect(win.locator('[data-health="alarms"]')).toHaveText(String(report.counts.alarms));
    await win.getByRole('navigation', { name: 'Health' }).getByRole('link', { name: /Watchdog/ }).click();
    const wdVerdict = win.locator('[data-health="watchdog-verdict"] .wall-headline');
    await expect(wdVerdict).toHaveText(headline(report.counts), { timeout: 30_000 });
    const card = win.locator(`li.finding[data-key="${broken!.key}"]`);
    await expect(card.locator('.finding-severity')).toHaveText('Broken');
    await expect(card.locator('.finding-scope')).toHaveText(`Source · ${crossref!.name}`);
    // The source by its name in the finding's own sentences, as on its scope, never by its key.
    await expect(card.locator('.finding-title')).toHaveText(`${crossref!.name} has failed on its last 3 runs`);
    await expect(card).not.toContainText(/\bcrossref\b/);
    // Stored timestamps read as times, never as ISO.
    await expect(card.locator('.finding-evidence')).not.toContainText(/\d{4}-\d{2}-\d{2}T/);

    const advice = win.locator('li.finding[data-key="source_in_part:biorxiv"]');
    await expect(advice.locator('.finding-title')).toHaveText('bioRxiv was answered in part on its last 3 runs');
    await expect(win.locator('.watchdog-group', { has: advice }).locator('h2')).toHaveText('Worth considering');
    await expect(advice.locator('.finding-evidence')).toContainText('Runs answered in part, in a row');
    await expect(advice.locator('.finding-detail')).toContainText('This is not a failure');
    await advice.scrollIntoViewIfNeeded();
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-health-in-part-advice.png') });

    // A withdrawn source: by the name it had, its streak not called failures, and its paragraph said once, whole.
    const withdrawn = win.locator('li.finding[data-key="source_errors:ieee"]');
    await expect(withdrawn).toHaveAttribute('data-withdrawn', 'true');
    await expect(withdrawn.locator('.finding-title')).toHaveText('IEEE Xplore was withdrawn from resmon');
    await expect(withdrawn.locator('.finding-scope')).toHaveText('Source · IEEE Xplore');
    await expect(withdrawn).not.toContainText(/\bieee\b/);
    await expect(withdrawn.locator('.finding-evidence')).not.toContainText('Failed runs in a row');
    await expect(withdrawn.locator('.finding-evidence')).toContainText('Runs in a row with nothing from it');
    await expect(withdrawn.locator('.finding-evidence')).not.toContainText('Most recent error');
    await expect(withdrawn.locator('.finding-detail')).toContainText('the terms they accepted at registration.');
    // Labeled for what it is, apart from the alarms, and not counted among them.
    await expect(withdrawn.locator('.finding-severity')).toHaveText('Withdrawn');
    await expect(win.locator('.watchdog-group', { has: withdrawn }).locator('h2')).toHaveText('Withdrawn from resmon');
    expect(report.findings.find((f) => f.key === 'source_errors:ieee')?.severity).toBe('withdrawn');
    // It never answered a run on record, and the card says so rather than naming a day.
    await expect(withdrawn.locator('.finding-evidence')).toContainText('Last answer on record');
    await expect(withdrawn.locator('.finding-evidence')).toContainText('None on record');
    await withdrawn.scrollIntoViewIfNeeded();
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-health-withdrawn.png') });

    await card.getByRole('button', { name: 'Mute', exact: true }).click();
    await expect(win.locator('[data-health="muted"] h2')).toHaveText('Muted (1)', { timeout: 30_000 });
    await expect(card).toHaveAttribute('data-muted', 'true');
    // A muted finding is not an alarm: one fewer is broken, in the verdict and on the tab.
    const quieter = await api<Report>(win, '/api/watchdog');
    expect(quieter.counts.broken).toBe(report.counts.broken - 1);
    await expect(wdVerdict).toHaveText(quieter.counts.broken || quieter.counts.unusual
      ? headline(quieter.counts) : /^None of the watchdog’s checks found anything/);
    if (quieter.counts.alarms) await expect(win.locator('[data-health="alarms"]')).toHaveText(String(quieter.counts.alarms));
    else await expect(win.locator('[data-health="alarms"]')).toHaveCount(0);
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-health-watchdog.png') });
    await card.getByRole('button', { name: 'Unmute', exact: true }).click();
    await expect(wdVerdict).toHaveText(headline(report.counts), { timeout: 30_000 });
    await expect(win.locator('[data-health="muted"]')).toHaveCount(0);

    // — this engine --------------------------------------------------------------
    const health = await api<{ identity: { runtime_id: string }; pid: number }>(win, '/api/health');
    await win.getByRole('navigation', { name: 'Health' }).getByRole('link', { name: 'This engine' }).click();
    await expect(win.locator('[data-health="status"]')).toContainText('Connected', { timeout: 30_000 });
    const port = await win.evaluate(() => (window as unknown as { resmonAPI: { getBackendPort(): string } }).resmonAPI.getBackendPort());
    await expect(win.locator('[data-health="status"]')).toContainText(`127.0.0.1:${port}`);
    await expect(win.locator('[data-health="details"]')).toContainText(health.identity.runtime_id);
    await expect(win.locator('[data-health="details"]')).toContainText(`pid ${health.pid}`);

    expect(problems).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
