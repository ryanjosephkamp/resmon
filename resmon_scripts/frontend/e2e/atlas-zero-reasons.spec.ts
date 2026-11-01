/**
 * Zero reasons a real backend produced, on Atlas's run page and in its run log.
 *
 * The components that word a zero are tested against data handed to them.
 * That is the shape defects have had here: the double could not fail the way
 * the real thing fails. So each reason below is produced by making the real
 * backend behave that way, against an authored source on loopback, and then
 * read where a person reads it:
 *
 * | Reason | How it is really produced | Network |
 * |---|---|---|
 * | `upstream_failure` | the source closes the connection without replying; the HTTP stack records a failed transport | loopback |
 * | `answered_empty` | an authored empty Atom feed over a real HTTP 200, parsed by the actual arXiv client | loopback |
 * | `not_recorded` | Open Library returns before HTTP for `max_results <= 0` | none |
 *
 * The first source response is held until the run page shows the run asking,
 * so "while it is happening" is a state the page is seen in rather than a
 * race. Each dive is started over the engine's API: what these cases are about
 * is the reason, not the form, which `atlas-search.spec.ts` drives.
 */
import * as fs from 'fs';
import * as path from 'path';
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { FRONTEND_ROOT, SCREENSHOT_DIR } from './fixtures/resmon-app';
import { launchSourceApp } from './fixtures/source-boundary';

test.describe.configure({ mode: 'serial' });

/** Start a Deep Dive over the engine's API, as the window's own client would. */
async function startDive(win: Page, body: Record<string, unknown>): Promise<number> {
  return win.evaluate(async (request) => {
    const port = (window as unknown as { resmonAPI: { getBackendPort(): string } }).resmonAPI.getBackendPort();
    const response = await e2eFetch(`http://127.0.0.1:${port}/api/search/dive`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
    });
    if (!response.ok) throw new Error(`dive failed: ${response.status} ${await response.text()}`);
    return (await response.json()).execution_id as number;
  }, body);
}

/** An arXiv dive over the last thirty days. */
function arxivDive(keyword: string): Record<string, unknown> {
  const to = new Date();
  const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
  return {
    repository: 'arxiv', query: keyword, keywords: [keyword],
    date_from: from.toISOString().slice(0, 10), date_to: to.toISOString().slice(0, 10),
    max_results: 20, ai_enabled: false,
  };
}

/** The run's own page, once it has stopped running. */
async function openSettled(win: Page, id: number): Promise<void> {
  await win.evaluate((run) => { window.location.hash = `#/runs/${run}`; }, id);
  await expect(win.locator(`.run[data-run="${id}"]`)).toBeVisible({ timeout: 30_000 });
  await expect(win.locator('.run')).not.toHaveAttribute('data-status', 'running', { timeout: 120_000 });
}

/** What the run page records for one source: its category, its words, and its sentence. */
async function recorded(win: Page, source: string) {
  const row = win.locator(`.recorded .recorded-row[data-source="${source}"]`);
  await expect(row).toBeVisible({ timeout: 30_000 });
  return {
    category: await row.getAttribute('data-category'),
    label: (await row.locator('.src-label').innerText()).trim(),
    note: (await row.locator('.src-note').innerText()).trim(),
  };
}

/** The run's Progress tab once it has finished: each source's last state and its words. */
async function progress(win: Page, source: string) {
  await win.getByRole('tab', { name: 'Progress' }).click();
  const row = win.locator(`.live-panel .live-row[data-source="${source}"]`);
  await expect(row).not.toHaveAttribute('data-state', /^(pending|asking)$/, { timeout: 30_000 });
  return { state: await row.getAttribute('data-state'), label: (await row.locator('.src-label').innerText()).trim() };
}

/** The run's line in the run log beside Ask the sources. */
async function logLine(win: Page, id: number): Promise<string> {
  await win.evaluate(() => { window.location.hash = '#/search/ask'; });
  const line = win.locator(`.run-row[data-run="${id}"] .run-status`);
  await expect(line).toBeVisible({ timeout: 30_000 });
  return (await line.innerText()).trim();
}

/** The run page while the held source has been asked and has not answered. */
async function seenAsking(win: Page, id: number): Promise<void> {
  await win.evaluate((run) => { window.location.hash = `#/runs/${run}`; }, id);
  await expect(win.locator(`.run[data-run="${id}"]`)).toHaveAttribute('data-status', 'running', { timeout: 30_000 });
  await expect(win.locator('.live-panel .live-row[data-source="arxiv"]')).toHaveAttribute('data-state', 'asking', { timeout: 30_000 });
}

test('P13a: upstream_failure — the source did not answer, live, on the run, and in the log', async () => {
  const source = await launchSourceApp('failure', { ui: 'atlas' });
  const { win, close } = source;
  try {
    const id = await startDive(win, arxivDive('machine learning'));
    await source.waitForRequest();
    await seenAsking(win, id);
    expect(source.stored(id).execution[0].status).toBe('running');
    source.release();

    await openSettled(win, id);
    const record = await recorded(win, 'arxiv');
    console.log('P13a RECORDED', JSON.stringify(record));
    expect(record.category).toBe('non_answer');
    expect(record.label).toContain('did not answer');
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-zero-upstream-failure.png') });

    const live = await progress(win, 'arxiv');
    console.log('P13a PROGRESS', JSON.stringify(live));
    expect(live).toEqual({ state: 'no_answer', label: 'did not answer' });

    const effect = source.evidence(id);
    expect(effect.requests.length).toBeGreaterThan(0);
    expect(effect.requests.every((r) => r.status === null && r.transport === 'closed-without-response')).toBe(true);
    expect(effect.stored.sources[0].zero_reason).toBe('upstream_failure');
    expect(effect.stored.documents).toHaveLength(0);

    const line = await logLine(win, id);
    console.log('P13a LOG', JSON.stringify(line));
    expect(line).toContain('0 of 1 source answered');
  } finally {
    await close();
  }
});

test('P13b: answered_empty — the source answered and had nothing', async () => {
  const source = await launchSourceApp('empty', { ui: 'atlas' });
  const { win, close } = source;
  try {
    // The actual source parser consumes the authored empty Atom response.
    const id = await startDive(win, arxivDive('zzqqxxjjkkvvwwyyplbb'));
    await source.waitForRequest();
    await seenAsking(win, id);
    expect(source.stored(id).execution[0].status).toBe('running');
    source.release();

    await openSettled(win, id);
    const record = await recorded(win, 'arxiv');
    console.log('P13b RECORDED', JSON.stringify(record));
    expect(record.category).toBe('answered');
    expect(record.label).toBe('answered, zero');
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-zero-answered-empty.png') });

    const live = await progress(win, 'arxiv');
    console.log('P13b PROGRESS', JSON.stringify(live));
    expect(live).toEqual({ state: 'answered', label: 'answered, zero' });

    const effect = source.evidence(id);
    expect(effect.requests).toHaveLength(1);
    expect(effect.requests[0]).toMatchObject({ method: 'GET', status: 200, transport: 'http-response' });
    expect(effect.requests[0].url).toContain('search_query=all%3Azzqqxxjjkkvvwwyyplbb');
    expect(effect.stored.sources[0]).toMatchObject({ status: 'ok', result_count: 0, zero_reason: 'answered_empty' });
    expect(effect.stored.documents).toHaveLength(0);

    // An answered zero is not a coverage problem: the log says the source
    // answered, and reporting it as anything else would be the mirror image
    // of the overclaim this surface exists to prevent.
    const line = await logLine(win, id);
    console.log('P13b LOG', JSON.stringify(line));
    expect(line).toContain('1 of 1 source answered');
    expect(line).toContain('0 found');
  } finally {
    await close();
  }
});

test('P13c: not_recorded — resmon did not observe why, and says exactly that', async () => {
  const source = await launchSourceApp('empty', { ui: 'atlas' });
  const { win, close } = source;
  try {
    // Open Library returns [] for `max_results <= 0` before making any HTTP
    // call at all, so the outcome channel holds nothing and `derive` reaches
    // its floor. Ask the sources cannot send 0, so the API does.
    const id = await startDive(win, {
      repository: 'openlibrary', query: 'reading', keywords: ['reading'],
      date_from: '2020-01-01', date_to: '2021-12-31', max_results: 0, ai_enabled: false,
    });
    await openSettled(win, id);
    const record = await recorded(win, 'openlibrary');
    console.log('P13c RECORDED', JSON.stringify(record));
    expect(record.category).toBe('unknown');
    expect(record.label).toBe('zero, reason not recorded');
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-zero-not-recorded.png') });

    const effect = source.evidence(id);
    expect(effect.requests).toHaveLength(0);
    expect(effect.stored.sources[0].zero_reason).toBe('not_recorded');

    const line = await logLine(win, id);
    console.log('P13c LOG', JSON.stringify(line));
    expect(line).toContain('0 of 1 source answered');

    // Reported rather than asserted: a search that makes no HTTP call is over
    // before the page could see it running, so its progress is only the record.
    await openSettled(win, id);
    await win.getByRole('tab', { name: 'Progress' }).click();
    const rows = await win.locator('.live-panel .live-row').evaluateAll((all) => all.map((row) => ({
      state: (row as HTMLElement).dataset.state, label: row.querySelector('.src-label')?.textContent?.trim(),
    })));
    console.log('P13c PROGRESS NOT VERIFIED', JSON.stringify(rows));
  } finally {
    await close();
  }
});

for (const mode of ['503', 'malformed'] as const) {
  test(`P13e: a source that answers ${mode === '503' ? 'HTTP 503' : 'with an unreadable reply'} is a recorded non-answer, never an empty answer`, async () => {
    const source = await launchSourceApp(mode, { ui: 'atlas' });
    const { win, close } = source;
    try {
      const id = await startDive(win, arxivDive('coverage fixture'));
      await source.waitForRequest();
      source.release();
      await openSettled(win, id);
      // Everything asked failed, so the run did.
      await expect(win.locator('.run')).toHaveAttribute('data-status', 'failed');
      const record = await recorded(win, 'arxiv');
      console.log(`P13e ${mode} RECORDED`, JSON.stringify(record));
      expect(record.category).toBe('non_answer');
      expect(record.label).toBe(mode === '503' ? 'did not answer' : 'reply unreadable');
      const effect = source.evidence(id);
      expect(effect.stored.sources[0].zero_reason).toBe(mode === '503' ? 'upstream_failure' : 'parse_failure');
      expect(effect.requests.every((r) => r.status === (mode === '503' ? 503 : 200))).toBe(true);
      const counts = await win.evaluate(async (run) => {
        const port = (window as unknown as { resmonAPI: { getBackendPort(): string } }).resmonAPI.getBackendPort();
        return (await (await e2eFetch(`http://127.0.0.1:${port}/api/executions/${run}/search-record`)).json()).coverage.counts;
      }, id);
      expect(counts).toMatchObject({ answered: 0, non_answer: 1, unknown: 0, genuine_empty: 0 });
    } finally {
      await close();
    }
  });
}

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
    'window_unanswerable', // zero-reason.spec.ts
    'upstream_failure', // P13a
    'answered_empty', // P13b
    'not_recorded', // P13c
    'parse_failure', // P13e
  ];
  const elsewhereOnly = all.filter((r) => !inRealBrowser.includes(r));
  console.log('P13d REASONS', JSON.stringify({ total: all.length, realBrowser: inRealBrowser, elsewhereOnly }));

  expect(all.length).toBe(10);
  for (const reason of inRealBrowser) expect(all).toContain(reason);
  // Named, not hidden: these five reach the renderer only through data handed
  // to it. `missing_key` and `retired` need configuration state,
  // `rights_filtered` and `records_unusable` need a live source that really
  // drops records on rights, and `entity_unsupported` needs a watch that
  // follows a person on a source that cannot be asked about one. A tenth
  // reason cannot be added without this list saying so.
  expect(elsewhereOnly.sort()).toEqual([
    'entity_unsupported', 'missing_key', 'records_unusable', 'retired', 'rights_filtered',
  ]);
});
