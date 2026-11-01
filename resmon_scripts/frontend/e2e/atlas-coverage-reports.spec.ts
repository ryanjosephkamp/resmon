/**
 * Recorded coverage on Atlas's run page, over authored histories.
 *
 * `test_coverage_reports.py seed` writes runs whose sources answered, answered
 * with nothing, failed, could not be read, left no outcome, and one that read
 * two records before a later request failed. Each is opened where a person
 * reads it, and reading them changes nothing stored.
 *
 * What the classic viewer did and Atlas does not, so nothing here checks it:
 * Atlas offers to save any run's search record, an empty one included; a
 * record that cannot be read says so without a Retry button (leaving the tab
 * and coming back reads it again); and a run's tab is not part of its address,
 * so there is no link straight to the Search record tab.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { FRONTEND_ROOT, SCREENSHOT_DIR, ATLAS_LANDMARK, atlasEnv, launchEnv } from './fixtures/resmon-app';

async function openRun(win: Page, id: number): Promise<void> {
  await win.evaluate((run) => { window.location.hash = `#/runs/${run}`; }, id);
  await expect(win.locator(`.run[data-run="${id}"]`)).toBeVisible({ timeout: 30_000 });
}

const recorded = (win: Page, source: string) => win.locator(`.recorded .recorded-row[data-source="${source}"]`);

test('recorded coverage: each outcome in its own words, a part-read source, an unreadable record, and nothing stored changed', async () => {
  test.setTimeout(240_000);
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-atlas-coverage-'));
  const env = atlasEnv(launchEnv(state, true));
  env.RESMON_DISABLE_SCHEDULER = '1';
  const helper = path.resolve(FRONTEND_ROOT, '../verification_scripts/test_coverage_reports.py');
  const fixture = JSON.parse(execFileSync(env.RESMON_PYTHON, [helper, 'seed', env.RESMON_DB_PATH], { env, encoding: 'utf8' })) as
    { coverage_ids: Record<string, number>; partial_sentence: string };
  const snapshot = () => execFileSync(env.RESMON_PYTHON, [helper, 'snapshot', env.RESMON_DB_PATH], { env, encoding: 'utf8' });
  const app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(state, 'electron-user-data')}`], cwd: FRONTEND_ROOT, env, timeout: 180_000 });
  try {
    const win = await app.firstWindow({ timeout: 180_000 });
    await win.locator(ATLAS_LANDMARK).waitFor({ state: 'visible', timeout: 60_000 });
    const port = await win.evaluate(() => (window as unknown as { resmonAPI: { getBackendPort(): string } }).resmonAPI.getBackendPort());
    expect(port).not.toBe('8742');
    // Taken once the engine has started, which writes its own defaults.
    const before = snapshot();

    // — six sources, each outcome in the record's own words ----------------------------
    const mixed = fixture.coverage_ids.mixed;
    await openRun(win, mixed);
    await expect(win.locator('[data-coverage-summary]')).toBeVisible({ timeout: 30_000 });
    const labels = await win.locator('.recorded .recorded-row').evaluateAll((rows) => Object.fromEntries(rows.map((row) => [
      (row as HTMLElement).dataset.source, row.querySelector('.src-label')?.textContent?.trim(),
    ])));
    console.log('ATLAS COVERAGE MIXED', JSON.stringify(labels));
    expect(labels).toMatchObject({ positive: 'answered', empty: 'answered, zero', 503: 'did not answer' });
    expect(Object.keys(labels).sort()).toEqual(['503', 'empty', 'missing', 'old', 'parse', 'positive']);
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-coverage-mixed.png') });

    // — read in part: the engine's sentence, and the Progress tab's word for it ---------
    const partial = fixture.coverage_ids.partial;
    await openRun(win, partial);
    await expect(recorded(win, 'arxiv').locator('.src-note')).toContainText(fixture.partial_sentence, { timeout: 30_000 });
    await win.getByRole('tab', { name: 'Progress' }).click();
    const live = win.locator('.live-panel .live-row[data-source="arxiv"]');
    await expect(live).toBeVisible({ timeout: 30_000 });
    const progressRow = { state: await live.getAttribute('data-state'), label: (await live.locator('.src-label').innerText()).trim(),
      note: (await live.locator('.src-note').allInnerTexts()).join(' ') };
    const events = await win.locator('.progress .events li').allInnerTexts();
    console.log('ATLAS COVERAGE PARTIAL PROGRESS', JSON.stringify({ progressRow, events }));
    // The count it kept, with the engine's sentence beside it and in the events.
    expect(progressRow.label).toBe('2 found');
    expect(progressRow.note).toContain(fixture.partial_sentence);
    expect(events.some((line) => line.includes(fixture.partial_sentence))).toBe(true);

    // — a run with no outcome recorded says so ------------------------------------------
    const empty = fixture.coverage_ids['no-history'];
    await openRun(win, empty);
    await expect(win.locator('[data-coverage-summary]')).toBeVisible({ timeout: 30_000 });
    await expect(win.locator('.recorded .recorded-row')).toHaveCount(0);

    // — a search record the engine cannot give says so, and the next reading recovers --
    const pattern = `**/api/executions/${mixed}/search-record`;
    await win.route(pattern, (route) => route.continue({ url: `http://127.0.0.1:${port}/api/executions/999999/search-record` }));
    await openRun(win, partial);
    await openRun(win, mixed);
    await win.getByRole('tab', { name: 'Search record' }).click();
    await expect(win.locator('.record-cap')).toContainText('The search record could not be read', { timeout: 30_000 });
    await win.unroute(pattern);
    await win.getByRole('tab', { name: 'Papers' }).click();
    await win.getByRole('tab', { name: 'Search record' }).click();
    await expect(win.locator('.search-record')).toBeVisible({ timeout: 30_000 });

    expect(snapshot(), 'reading recorded coverage changed something stored').toBe(before);
  } finally {
    await app.close().catch(() => { /* already gone */ });
    fs.rmSync(state, { recursive: true, force: true });
  }
});
