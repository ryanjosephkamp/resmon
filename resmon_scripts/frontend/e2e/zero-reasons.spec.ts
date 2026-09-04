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
 * | `upstream_failure` | the app is launched with `ALL_PROXY` pointing at a **closed loopback port**, so every outbound call from the backend is refused at connect | none |
 * | `answered_empty` | a live query for a term nothing matches — the source really does answer 200 with nothing | yes |
 * | `not_recorded` | Open Library returns `[]` for `max_results <= 0` **before making any HTTP call**, so the outcome channel holds nothing and `derive` reaches its honest floor | none |
 *
 * The proxy is the interesting one. `httpx.Client` is built with
 * `trust_env` at its default, so `ALL_PROXY` reaches every source client
 * without a line of production code knowing this test exists — and a *closed*
 * port produces `httpx.ConnectError`, which is a transport failure resmon
 * genuinely cannot distinguish from the upstream being down. `NO_PROXY` keeps
 * the renderer's own loopback traffic out of it.
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
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { launchEnv, FRONTEND_ROOT, ensureScreenshotDir } from './fixtures/resmon-app';

test.describe.configure({ mode: 'serial' });

interface Launched {
  app: ElectronApplication;
  win: Page;
  close: () => Promise<void>;
}

/** A loopback port with nothing listening on it. Refuses every connection. */
async function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

async function launch(proxyPort: number | null): Promise<Launched> {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-zero-'));
  const env = launchEnv(stateDir, true);
  const args = ['.', `--user-data-dir=${path.join(stateDir, 'electron-user-data')}`];
  if (proxyPort !== null) {
    // Read by httpx through `trust_env`, which is on by default, so every
    // source client goes through it with no production code involved.
    env.ALL_PROXY = `http://127.0.0.1:${proxyPort}`;
    env.HTTPS_PROXY = env.ALL_PROXY;
    env.HTTP_PROXY = env.ALL_PROXY;
    // The renderer talks to the backend over loopback and must not be routed
    // into a dead port — that would break the app rather than one source.
    env.NO_PROXY = '127.0.0.1,localhost';
    env.no_proxy = env.NO_PROXY;
    // Chromium on Linux reads the same variables. Belt and braces: the window
    // itself never uses a proxy.
    args.push('--no-proxy-server');
  }
  const app = await electron.launch({
    args, cwd: FRONTEND_ROOT, env, timeout: 180_000,
  });
  const win = await app.firstWindow({ timeout: 180_000 });
  await win.waitForLoadState('domcontentloaded');
  await win.locator('.app-main').waitFor({ state: 'visible', timeout: 60_000 });
  const port = await win.evaluate(
    () => (window as unknown as { resmonAPI: { getBackendPort(): string } })
      .resmonAPI.getBackendPort(),
  );
  expect(port).not.toBe('8742');
  return {
    app,
    win,
    close: async () => {
      await app.close().catch(() => { /* already gone */ });
      fs.rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

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
): Promise<void> {
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
  await win.locator('button', { hasText: 'Run Deep Dive' }).click();
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

/** Open the newest execution's search record from the Results page. */
async function openNewestSearchRecord(win: Page): Promise<void> {
  await goto(win, '/results');
  await expect(win.locator('tr.clickable-row').first()).toBeVisible({ timeout: 30_000 });
  await win.locator('tr.clickable-row').first().click();
  await win.locator('.tab-bar .tab-btn', { hasText: 'Search record' }).first().click();
  await expect(win.locator('.search-record')).toBeVisible({ timeout: 30_000 });
}

test('P13a: upstream_failure — the source did not answer, on all three surfaces', async () => {
  const port = await closedPort();
  const { win, close } = await launch(port);
  try {
    await runDiveFromTheForm(win, 'arxiv', 'machine learning');

    // --- the monitor, while it is happening -----------------------------
    await goto(win, '/monitor');
    const reason = win.locator('.mon-repo-zero-reason').first();
    await expect(reason).toContainText('could not be queried', { timeout: 90_000 });
    await expect(reason).toContainText('did not answer');
    await expect(win.locator('.mon-repo-icon--no_answer').first()).toBeVisible();
    const monitorSentence = (await reason.innerText()).trim();
    console.log('P13a MONITOR', JSON.stringify(monitorSentence));
    await win.screenshot({
      path: path.join(ensureScreenshotDir(), '19-monitor-upstream-failure.png'),
    });

    // --- what the backend actually recorded ------------------------------
    const id = await win.evaluate(async () => {
      const p = (window as unknown as { resmonAPI: { getBackendPort(): string } })
        .resmonAPI.getBackendPort();
      const rows = await (await fetch(`http://127.0.0.1:${p}/api/executions?limit=1`)).json();
      return (rows.executions ?? rows)[0].id as number;
    });
    await settled(win, id);
    const reasons = await recordedReasons(win, id);
    console.log('P13a RECORDED', JSON.stringify(reasons));
    expect(Object.values(reasons)).toContain('upstream_failure');

    // --- the results row --------------------------------------------------
    await goto(win, '/results');
    await expect(win.locator('.results-coverage').first())
      .toContainText('could not answer', { timeout: 30_000 });

    // --- the search record ------------------------------------------------
    await openNewestSearchRecord(win);
    await expect(win.locator('.record-notes')).toContainText('did not answer');
    await expect(win.locator('.search-record .simple-table').first())
      .toContainText('did not answer');
    await win.locator('.record-notes').scrollIntoViewIfNeeded();
    await win.screenshot({
      path: path.join(ensureScreenshotDir(), '20-search-record-upstream-failure.png'),
    });
  } finally {
    await close();
  }
});

test('P13b: answered_empty — the source answered and had nothing', async () => {
  const { win, close } = await launch(null);
  try {
    // A term nothing matches. The source really does reply, with an empty
    // result set, which is the only honest way to produce this reason.
    await runDiveFromTheForm(win, 'arxiv', 'zzqqxxjjkkvvwwyyplbb');

    await goto(win, '/monitor');
    const reason = win.locator('.mon-repo-zero-reason').first();
    await expect(reason).toBeVisible({ timeout: 90_000 });
    const sentence = (await reason.innerText()).trim();
    console.log('P13b MONITOR', JSON.stringify(sentence));

    if (sentence.includes('could not be queried')) {
      // The machine could not reach the source. Say so; do not turn an outage
      // into a claim about the wrong reason.
      console.log('P13b NOT VERIFIED — arXiv was unreachable from this machine');
      test.skip(true, 'arXiv unreachable — answered_empty needs a source that answers');
    }
    expect(sentence).toContain('answered (HTTP 200)');
    expect(sentence).toContain('no records');

    const id = await win.evaluate(async () => {
      const p = (window as unknown as { resmonAPI: { getBackendPort(): string } })
        .resmonAPI.getBackendPort();
      const rows = await (await fetch(`http://127.0.0.1:${p}/api/executions?limit=1`)).json();
      return (rows.executions ?? rows)[0].id as number;
    });
    await settled(win, id);
    const reasons = await recordedReasons(win, id);
    console.log('P13b RECORDED', JSON.stringify(reasons));
    expect(Object.values(reasons)).toContain('answered_empty');

    // The results row deliberately says **nothing**. An answered zero is not a
    // coverage problem, and reporting it as one would be the mirror image of
    // the overclaim this surface exists to prevent.
    await goto(win, '/results');
    await expect(win.locator('tr.clickable-row').first()).toBeVisible({ timeout: 30_000 });
    await expect(win.locator('.results-coverage')).toHaveCount(0);

    await openNewestSearchRecord(win);
    await expect(win.locator('.search-record .simple-table').first())
      .toContainText('answered, zero');
    await expect(win.locator('.record-notes')).toContainText('answered (HTTP 200)');
    await win.screenshot({
      path: path.join(ensureScreenshotDir(), '21-search-record-answered-empty.png'),
    });
  } finally {
    await close();
  }
});

test('P13c: not_recorded — resmon did not observe why, and says exactly that', async () => {
  const { win, close } = await launch(null);
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

    // --- the results row --------------------------------------------------
    await goto(win, '/results');
    await expect(win.locator('.results-coverage').first())
      .toContainText('returned nothing for a reason resmon did not record',
        { timeout: 30_000 });
    await win.screenshot({
      path: path.join(ensureScreenshotDir(), '22-results-not-recorded.png'),
    });

    // --- the search record ------------------------------------------------
    await openNewestSearchRecord(win);
    await expect(win.locator('.search-record .simple-table').first())
      .toContainText('zero, reason not recorded');
    await expect(win.locator('.record-notes'))
      .toContainText('did not record whether Open Library answered');
    await win.locator('.record-notes').scrollIntoViewIfNeeded();
    await win.screenshot({
      path: path.join(ensureScreenshotDir(), '23-search-record-not-recorded.png'),
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

test('P13d: the nine reasons, and which of them a real browser has now seen', async () => {
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

  expect(all.length).toBe(9);
  for (const reason of inRealBrowser) expect(all).toContain(reason);
  // Named, not hidden: these five reach the renderer only through jsdom
  // fixtures. `missing_key` and `retired` need configuration state,
  // `rights_filtered` and `records_unusable` need a live source that really
  // drops records on rights, and `parse_failure` needs an upstream that
  // answers 200 with something unreadable.
  expect(jsdomOnly.sort()).toEqual([
    'missing_key', 'parse_failure', 'records_unusable', 'retired', 'rights_filtered',
  ]);
});
