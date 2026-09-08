/**
 * The rest of the zero reasons, in the real app.
 *
 * Phase 1.8.6 gave nine reasons a sentence and drove **one** of them —
 * `window_unanswerable`, in `zero-reason.spec.ts` — through Electron, because
 * it is the one that needs no network at all. The other eight were asserted in
 * jsdom, against components handed the data by hand. That is the shape the last
 * three shipped defects had: the double could not fail the way the real thing
 * fails.
 *
 * Three more reasons reach a real browser here, each seeded by making the real
 * backend actually behave that way rather than by handing the renderer a
 * fixture:
 *
 * | Reason | How it is really produced | Network |
 * |---|---|---|
 * | `upstream_failure` | local source closes the real connection without replying; the actual HTTP stack records failed transport | loopback |
 * | `answered_empty` | authored empty Atom feed over real HTTP 200, parsed by the actual arXiv client | loopback |
 * | `not_recorded` | Open Library returns before HTTP for `max_results <= 0` | none |
 *
 * The first source response is held until Monitor shows the exact execution.
 * This controls dependency timing, not backend progress or renderer state. A
 * refused/failed transport cannot be silently skipped as an unavailable empty
 * answer. These cases establish local parser/outcome handling, not availability
 * of a public provider.
 *
 * **`not_recorded` and the Monitor.** `max_results: 0` is not reachable from
 * the Deep Dive form — its slider starts at 10 — so that run is seeded through
 * the API. `ExecutionContext` does adopt background-initiated runs: it polls
 * `/api/executions/active` and calls `startExecution` for any id it is not
 * already tracking. (Phase 1.8.6's spec says the Monitor "only tracks
 * executions this renderer started"; that is not quite right, and the
 * difference matters here.) But a search that returns before making a single
 * HTTP call is finished long before the next poll, so there is nothing active
 * to adopt. That arm **reports what it observed rather than asserting it**,
 * and the surface `not_recorded` actually belongs to is a **pre-1.8.6 row in
 * somebody's history** — a Results row and a search record, both asserted.
 */
import * as fs from 'fs';
import * as path from 'path';
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { FRONTEND_ROOT, ensureScreenshotDir } from './fixtures/resmon-app';
import { launchSourceApp } from './fixtures/source-boundary';

test.describe.configure({ mode: 'serial' });

async function goto(win: Page, hash: string): Promise<void> {
  await win.evaluate((h) => { window.location.hash = `#${h}`; }, hash);
  await win.waitForFunction((h) => window.location.hash.startsWith(`#${h}`), hash,
    { timeout: 15_000 });
  await win.waitForLoadState('networkidle').catch(() => { /* long-poll pages never idle */ });
  await win.waitForTimeout(400);
}

/** Fill in the Deep Dive form and press the button, as a person would. */
async function runDiveFromTheForm(
  win: Page, repository: string, keyword: string,
  dates?: { from: string; to: string },
): Promise<number> {
  await goto(win, '/dive');
  await win.locator('select.form-select')
    .filter({ has: win.locator(`option[value="${repository}"]`) })
    .selectOption(repository);
  if (dates) {
    await win.locator('.date-input-group input').first().fill(dates.from);
    await win.locator('.date-input-group input').nth(1).fill(dates.to);
  }
  await win.locator('.keyword-input-row input').fill(keyword);
  await win.locator('.keyword-input-row button', { hasText: 'Add' }).click();
  const response = win.waitForResponse((r) => r.url().endsWith('/api/search/dive') && r.request().method() === 'POST');
  await win.locator('button', { hasText: 'Run Deep Dive' }).click();
  const started = await response; expect(started.ok()).toBe(true);
  const id = (await started.json()).execution_id as number;
  expect(id).toBeGreaterThan(0); return id;
}

/** Wait for an execution to stop running, and return its API row. */
async function settled(win: Page, id: number): Promise<Record<string, unknown>> {
  return win.evaluate(async (execId) => {
    const port = (window as unknown as { resmonAPI: { getBackendPort(): string } })
      .resmonAPI.getBackendPort();
    const deadline = Date.now() + 120_000;
    let row: Record<string, unknown> = {};
    while (Date.now() < deadline) {
      row = await (await fetch(`http://127.0.0.1:${port}/api/executions/${execId}`)).json();
      if (row.status !== 'running') return row;
      await new Promise((r) => setTimeout(r, 500));
    }
    return row;
  }, id);
}

/** The zero reason the backend recorded for each source of one execution. */
async function recordedReasons(win: Page, id: number): Promise<Record<string, string>> {
  return win.evaluate(async (execId) => {
    const port = (window as unknown as { resmonAPI: { getBackendPort(): string } })
      .resmonAPI.getBackendPort();
    const rec = await (await fetch(
      `http://127.0.0.1:${port}/api/executions/${execId}/search-record`)).json();
    const out: Record<string, string> = {};
    // `source` is the slug — measured, not assumed: the record keys read back
    // as "arxiv" and "openlibrary", not as display names.
    for (const s of rec.sources ?? []) out[s.source] = s.zero_reason ?? '';
    return out;
  }, id);
}

/** Open this execution, not whichever row happens to be newest. */
async function openSearchRecord(win: Page, id: number): Promise<void> {
  await goto(win, '/results');
  const row = win.getByText(`Execution #${id}`, { exact: true }).locator('xpath=ancestor::tr');
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();
  await win.locator('.tab-bar .tab-btn', { hasText: 'Search record' }).first().click();
  await expect(win.locator('.search-record')).toBeVisible({ timeout: 30_000 });
}

test('P13a: upstream_failure — the source did not answer, on all three surfaces', async () => {
  const source = await launchSourceApp('failure');
  const { win, close } = source;
  try {
    const id = await runDiveFromTheForm(win, 'arxiv', 'machine learning');
    await source.waitForRequest();

    // --- the monitor, while it is happening -----------------------------
    await goto(win, '/monitor');
    await expect(win.getByTestId(`mon-tab-${id}`)).toBeVisible();
    await win.getByTestId(`mon-tab-${id}`).click();
    expect(source.stored(id).execution[0].status).toBe('running');
    source.release();
    const reason = win.locator('.mon-repo-zero-reason').first();
    await expect(reason).toContainText('could not be queried', { timeout: 90_000 });
    await expect(reason).toContainText('did not answer');
    await expect(win.locator('.mon-repo-icon--no_answer').first()).toBeVisible();
    const monitorSentence = (await reason.innerText()).trim();
    console.log('P13a MONITOR', JSON.stringify(monitorSentence));
    await win.screenshot({
      path: path.join(ensureScreenshotDir(), '34-monitor-upstream-failure.png'),
    });

    // --- what the backend actually recorded ------------------------------
    await settled(win, id);
    const reasons = await recordedReasons(win, id);
    console.log('P13a RECORDED', JSON.stringify(reasons));
    expect(reasons.arxiv).toBe('upstream_failure');
    const effect = source.evidence(id);
    expect(effect.requests.length).toBeGreaterThan(0);
    expect(effect.requests.every((r) => r.status === null && r.transport === 'closed-without-response')).toBe(true);
    expect(effect.stored.sources[0].zero_reason).toBe('upstream_failure');
    expect(effect.stored.documents).toHaveLength(0);

    // --- the results row --------------------------------------------------
    await goto(win, '/results');
    await expect(win.locator('.results-coverage').first())
      .toContainText('could not answer', { timeout: 30_000 });

    // --- the search record ------------------------------------------------
    await openSearchRecord(win, id);
    await expect(win.locator('.record-notes')).toContainText('did not answer');
    await expect(win.locator('.search-record .simple-table').first())
      .toContainText('did not answer');
    await win.locator('.record-notes').scrollIntoViewIfNeeded();
    await win.screenshot({
      path: path.join(ensureScreenshotDir(), '35-search-record-upstream-failure.png'),
    });
  } finally {
    await close();
  }
});

test('P13b: answered_empty — the source answered and had nothing', async () => {
  const source = await launchSourceApp('empty');
  const { win, close } = source;
  try {
    // The actual source parser consumes the authored empty Atom response.
    const id = await runDiveFromTheForm(win, 'arxiv', 'zzqqxxjjkkvvwwyyplbb');
    await source.waitForRequest();

    await goto(win, '/monitor');
    await expect(win.getByTestId(`mon-tab-${id}`)).toBeVisible();
    await win.getByTestId(`mon-tab-${id}`).click();
    expect(source.stored(id).execution[0].status).toBe('running');
    source.release();
    const reason = win.locator('.mon-repo-zero-reason').first();
    await expect(reason).toBeVisible({ timeout: 90_000 });
    const sentence = (await reason.innerText()).trim();
    console.log('P13b MONITOR', JSON.stringify(sentence));

    expect(sentence).toContain('answered (HTTP 200)');
    expect(sentence).toContain('no records');

    await settled(win, id);
    const reasons = await recordedReasons(win, id);
    console.log('P13b RECORDED', JSON.stringify(reasons));
    expect(reasons.arxiv).toBe('answered_empty');
    const effect = source.evidence(id);
    expect(effect.requests).toHaveLength(1);
    expect(effect.requests[0]).toMatchObject({ method: 'GET', status: 200, transport: 'http-response' });
    expect(effect.requests[0].url).toContain('search_query=all%3Azzqqxxjjkkvvwwyyplbb');
    expect(effect.stored.sources[0]).toMatchObject({ status: 'ok', result_count: 0, zero_reason: 'answered_empty' });
    expect(effect.stored.documents).toHaveLength(0);

    // The results row deliberately says **nothing**. An answered zero is not a
    // coverage problem, and reporting it as one would be the mirror image of
    // the overclaim this surface exists to prevent.
    await goto(win, '/results');
    await expect(win.locator('tr.clickable-row').first()).toBeVisible({ timeout: 30_000 });
    await expect(win.locator('.results-coverage')).toHaveCount(0);

    await openSearchRecord(win, id);
    await expect(win.locator('.search-record .simple-table').first())
      .toContainText('answered, zero');
    await expect(win.locator('.record-notes')).toContainText('answered (HTTP 200)');
    await win.screenshot({
      path: path.join(ensureScreenshotDir(), '36-search-record-answered-empty.png'),
    });
  } finally {
    await close();
  }
});

test('P13c: not_recorded — resmon did not observe why, and says exactly that', async () => {
  const source = await launchSourceApp('empty');
  const { win, close } = source;
  try {
    // Open Library returns [] for `max_results <= 0` before making any HTTP
    // call at all, so the outcome channel holds nothing and `derive` reaches
    // its floor. Seeded through the API because the Deep Dive slider starts at
    // 10 — see the note at the top of this file.
    const id = await win.evaluate(async () => {
      const p = (window as unknown as { resmonAPI: { getBackendPort(): string } })
        .resmonAPI.getBackendPort();
      const res = await fetch(`http://127.0.0.1:${p}/api/search/dive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repository: 'openlibrary',
          query: 'reading',
          keywords: ['reading'],
          date_from: '2020-01-01',
          date_to: '2021-12-31',
          max_results: 0,
          ai_enabled: false,
        }),
      });
      if (!res.ok) throw new Error(`dive failed: ${res.status} ${await res.text()}`);
      return (await res.json()).execution_id as number;
    });
    const row = await settled(win, id);
    expect(row.status).toBe('completed');
    const outcomes = row.source_outcomes as Record<string, number>;
    console.log('P13c OUTCOMES', JSON.stringify(outcomes));
    expect(outcomes.not_recorded).toBe(1);
    expect(outcomes.answered).toBe(0);

    const reasons = await recordedReasons(win, id);
    console.log('P13c RECORDED', JSON.stringify(reasons));
    expect(reasons.openlibrary).toBe('not_recorded');
    const effect = source.evidence(id);
    expect(effect.requests).toHaveLength(0);
    expect(effect.stored.sources[0].zero_reason).toBe('not_recorded');

    // --- the results row --------------------------------------------------
    await goto(win, '/results');
    await expect(win.locator('.results-coverage').first())
      .toContainText('returned nothing for a reason resmon did not record',
        { timeout: 30_000 });
    await win.screenshot({
      path: path.join(ensureScreenshotDir(), '37-results-not-recorded.png'),
    });

    // --- the search record ------------------------------------------------
    await openSearchRecord(win, id);
    await expect(win.locator('.search-record .simple-table').first())
      .toContainText('zero, reason not recorded');
    await expect(win.locator('.record-notes'))
      .toContainText('did not record whether Open Library answered');
    await win.locator('.record-notes').scrollIntoViewIfNeeded();
    await win.screenshot({
      path: path.join(ensureScreenshotDir(), '38-search-record-not-recorded.png'),
    });

    // --- the monitor, reported rather than asserted -----------------------
    await goto(win, '/monitor');
    const rows = await win.locator('.mon-repo-zero-reason').count();
    console.log(
      'P13c MONITOR NOT VERIFIED — ExecutionContext adopts a run only while it is',
      'still in /api/executions/active, and a search that makes no HTTP call is',
      'over before the next poll; the Deep Dive slider cannot send max_results: 0.',
      `Zero-reason rows on the Monitor: ${rows}.`,
    );
  } finally {
    await close();
  }
});

test('P13d: the ten reasons, and which of them a real browser has now seen', async () => {
  // The denominator, taken from the code rather than counted here: a reason
  // added to `zero_reason.ZERO_REASONS` with no real-browser case shows up in
  // this list rather than being quietly absent.
  const source = fs.readFileSync(
    path.resolve(FRONTEND_ROOT, '..', 'implementation_scripts', 'zero_reason.py'), 'utf8');
  const block = source.match(/ZERO_REASONS = \(([\s\S]*?)\)/);
  expect(block).toBeTruthy();
  const all = [...(block as RegExpMatchArray)[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);

  // Driven through the assembled app against a real backend.
  const inRealBrowser = [
    'window_unanswerable', // zero-reason.spec.ts, phase 1.8.6
    'upstream_failure', // P13a
    'answered_empty', // P13b
    'not_recorded', // P13c
  ];
  const jsdomOnly = all.filter((r) => !inRealBrowser.includes(r));
  console.log('P13d REASONS', JSON.stringify({
    total: all.length, realBrowser: inRealBrowser, jsdomOnly,
  }));

  expect(all.length).toBe(10);
  for (const reason of inRealBrowser) expect(all).toContain(reason);
  // Named, not hidden: these six reach the renderer only through jsdom
  // fixtures. `missing_key` and `retired` need configuration state,
  // `rights_filtered` and `records_unusable` need a live source that really
  // drops records on rights, and `parse_failure` needs an upstream that
  // answers 200 with something unreadable.
  //
  // `entity_unsupported` is 2.1's, and it is here for a different reason from
  // the other five: it is not hard to reach, it is **unreachable from the
  // interface** — a watch routine is what produces it and the Profiles page and
  // the routine's Watch mode were not built. This test is what refused to let a
  // tenth reason be added without saying so, which is the whole point of taking
  // the denominator from `ZERO_REASONS` rather than counting here.
  expect(jsdomOnly.sort()).toEqual([
    'entity_unsupported', 'missing_key', 'parse_failure', 'records_unusable',
    'retired', 'rights_filtered',
  ]);
});
