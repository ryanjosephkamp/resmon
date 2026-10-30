/**
 * Atlas: a watch that asks for papers published since its previous run, made
 * in the editor and run twice with Run now, in the real app.
 *
 * arXiv is the suite's authored loopback source (`fixtures/source-boundary.ts`),
 * which records every request the engine's arXiv client sends it. The dates
 * each run asked for are read off those requests (arXiv's `submittedDate`
 * clause), not off the screen: the first run has no run before it and asks for
 * the last 7 days; the second asks from 3 days before the first run started.
 * The engine's record of each run, the watch's page, the run's page and the
 * search record are then held to the same dates.
 *
 * Every step a person takes is taken with the controls; the engine is read only
 * to check what the screen wrote and what each run recorded. The watch is saved
 * paused: Run now runs a paused watch once, and nothing runs it on a clock.
 */
import * as path from 'path';
import { test, expect, type Page } from '@playwright/test';
import { SCREENSHOT_DIR } from './fixtures/resmon-app';
import { launchSourceApp, sourceApi } from './fixtures/source-boundary';

type Json = Record<string, unknown>;

/** A local calendar day, `days` before today, as the engine counts this computer's days. */
function dayBefore(from: Date, days: number): Date {
  return new Date(from.getFullYear(), from.getMonth(), from.getDate() - days);
}
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const words = (d: Date) => d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
/** arXiv's `submittedDate` lower bound for a start day: YYYYMMDD0000. */
const arxivFrom = (d: Date) => `${iso(d).replace(/-/g, '')}0000`;

/** Run now, pressed on the watch's page; the run it started, by the engine's answer. */
async function runNow(win: Page, id: number): Promise<number> {
  const answered = win.waitForResponse((r) => r.url().endsWith(`/api/routines/${id}/run`) && r.request().method() === 'POST');
  await win.getByRole('button', { name: 'Run now', exact: true }).click();
  const response = await answered;
  expect(response.ok(), `Run now was refused: HTTP ${response.status()}`).toBe(true);
  const started = Number(((await response.json()) as Json).execution_id);
  await expect(win.locator('.run-now-said')).toHaveAttribute('data-run-started', String(started), { timeout: 30_000 });
  return started;
}

/** What one arXiv request asked: its terms and its submittedDate window. */
function asked(query: string | undefined, from: Date): void {
  expect(query ?? '').toContain('graph');
  expect(query ?? '').toMatch(new RegExp(` AND submittedDate:\\[${arxivFrom(from)} TO 209912312359\\]$`));
}

async function settled(win: Page, id: number): Promise<Json> {
  let run: Json = {};
  await expect.poll(async () => {
    run = await sourceApi(win, `/api/executions/${id}`);
    return run.status;
  }, { timeout: 120_000 }).not.toBe('running');
  return run;
}

test('a watch since its previous run: made in the editor, run twice, and the dates each run asked', async () => {
  test.setTimeout(420_000);
  const source = await launchSourceApp('authored-corpus', { ui: 'atlas' });
  const { win, requests } = source;
  try {
    const problems: string[] = [];
    win.on('pageerror', (e) => problems.push(e.message));

    // — made in the editor, with the window it offers first -----------------
    await win.evaluate(() => { window.location.hash = '#/watches'; });
    await win.locator('[data-editor="new"]').click();
    await win.locator('.source[data-source="arxiv"]').waitFor({ timeout: 60_000 });
    const choices = win.locator('[data-editor="window"] input[name="watch-window"]');
    await expect(choices).toHaveCount(4);
    expect(await choices.evaluateAll((inputs) => inputs.map((i) => (i as HTMLInputElement).value)))
      .toEqual(['previous_run', 'last_days', 'between', 'none']);
    await expect(win.getByRole('radio', { name: 'Papers published since the previous run' })).toBeChecked();
    await expect(win.locator('[data-editor="window-hint"]')).toContainText('from 3 days before it started');
    // No date limit says plainly what it means, naming the sources from the catalog.
    await win.getByRole('radio', { name: 'No date limit' }).check();
    await expect(win.locator('[data-editor="window-hint"]')).toContainText('newest first from arXiv');
    await expect(win.locator('[data-editor="window-hint"]')).toContainText('the most relevant of all years from');
    await expect(win.locator('[data-editor="window-hint"]')).toContainText('CrossRef, DataCite');
    await win.getByRole('radio', { name: 'Papers published since the previous run' }).check();

    await win.locator('#watch-name').fill('Graphs since the last run');
    await win.locator('#watch-terms').fill('graph');
    await win.keyboard.press('Enter');
    await win.locator('.source[data-source="arxiv"] input').check();
    await win.locator('[data-switch="is_active"]').click();
    await expect(win.locator('[data-switch="is_active"]')).toHaveAttribute('aria-checked', 'false');
    await expect(win.locator('[data-will="asks"] p').first())
      .toHaveText('Asks arXiv for papers matching “graph”, published since its previous run, up to 100 from each.');
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-watch-window-editor.png') });
    await win.getByRole('button', { name: 'Save watch' }).click();
    await expect(win.locator('.watch-page [data-editor="said"]')).toHaveText('Saved, paused.', { timeout: 30_000 });
    const id = Number(/#\/watches\/(\d+)$/.exec(win.url())?.[1]);
    expect(id).toBeGreaterThan(0);

    const watch = await sourceApi(win, `/api/routines/${id}`);
    expect(JSON.parse(String(watch.parameters))).toMatchObject({
      repositories: ['arxiv'], keywords: ['graph'], date_window: { since: 'previous_run' }, date_from: '', date_to: '',
    });

    // Its page says the first run asks for the last 7 days, with the date.
    const today = new Date();
    const firstFrom = dayBefore(today, 7);
    const dates = win.locator('.watch-page [data-watch="window"]');
    await expect(dates).toHaveAttribute('data-window', 'previous_run');
    await expect(dates).toContainText(`its next run asks for the last 7 days: from ${words(firstFrom)}`);

    // — the first run: no run before it --------------------------------------
    const before = requests.length;
    const first = await runNow(win, id);
    const firstRun = await settled(win, first);
    const firstAsked = requests.slice(before).filter((r) => r.provider === 'arxiv');
    expect(firstAsked.length).toBeGreaterThan(0);
    for (const request of firstAsked) asked(request.params.search_query, firstFrom);
    const firstParams = JSON.parse(String(firstRun.parameters)) as Json;
    expect(firstParams).toMatchObject({ date_from: iso(firstFrom), date_to: null });
    expect(firstParams.date_window_computed).toMatchObject({ basis: 'no_previous_run', default_days: 7, date_from: iso(firstFrom) });
    // arXiv answered, so this run is the one the next window starts from.
    expect((firstRun.coverage as { counts: { answered: number } }).counts.answered).toBe(1);

    // — the second run: from 3 days before the first began --------------------
    const firstStart = new Date(String(firstRun.start_time));
    const secondFrom = dayBefore(firstStart, 3);
    await expect(dates).toContainText(
      `The next run asks for papers published from ${words(secondFrom)}, with no end date: run ${first}`, { timeout: 30_000 });
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-watch-window-page.png') });
    const between = requests.length;
    const second = await runNow(win, id);
    expect(second).not.toBe(first);
    const secondRun = await settled(win, second);
    const secondAsked = requests.slice(between).filter((r) => r.provider === 'arxiv');
    expect(secondAsked.length).toBeGreaterThan(0);
    for (const request of secondAsked) asked(request.params.search_query, secondFrom);
    const secondParams = JSON.parse(String(secondRun.parameters)) as Json;
    expect(secondParams).toMatchObject({ date_from: iso(secondFrom), date_to: null });
    expect(secondParams.date_window_computed).toMatchObject({
      basis: 'previous_run', previous_execution_id: first, overlap_days: 3, date_from: iso(secondFrom),
    });

    // — every account of the second run states those dates -------------------
    await win.locator('.run-now-said').getByRole('link', { name: `Open run ${second}` }).click();
    const runDates = win.locator(`.run[data-run="${second}"] [data-run="window"]`);
    await expect(runDates).toContainText(`Papers published since the previous run: from ${words(secondFrom)}, with no end date.`,
      { timeout: 30_000 });
    await expect(runDates).toContainText(`Run ${first}, the latest earlier run in which a source answered`);
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-watch-window-run.png') });
    const record = await sourceApi(win, `/api/executions/${second}/search-record`) as { search: Json };
    expect(record.search).toMatchObject({ date_from: iso(secondFrom), date_to: null });
    expect(record.search.date_window).toMatchObject({ previous_execution_id: first });
    // The watch itself is unchanged by running: its dates are computed, never stored on it.
    expect(JSON.parse(String((await sourceApi(win, `/api/routines/${id}`)).parameters)))
      .toMatchObject({ date_window: { since: 'previous_run' }, date_from: '', date_to: '' });

    expect(problems).toEqual([]);
  } finally {
    await source.close();
  }
});
