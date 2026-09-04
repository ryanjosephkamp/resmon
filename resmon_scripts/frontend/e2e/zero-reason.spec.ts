/**
 * Why nothing came back — the three surfaces, in the real app.
 *
 * jsdom proves the components render from the data they are handed. This
 * proves the assembled Electron app puts that data on screen: a real backend
 * on a real socket, a real sweep, a real click, and screenshots of what a
 * person would actually see.
 *
 * **The seed is deterministic and needs no network.** ERIC exposes only a
 * publication year, so a window shorter than one whole calendar year cannot be
 * answered — the client refuses it and makes no HTTP call at all. That is a
 * recorded zero with a recorded reason, produced identically on a laptop and
 * on a CI runner with no route to the internet, which is exactly the property
 * a seeded fixture needs and exactly the zero this phase exists to explain.
 */
import * as path from 'path';
import { test, expect, ensureScreenshotDir } from './fixtures/resmon-app';

test.describe.configure({ mode: 'serial' });

const WINDOW_SENTENCE =
  'ERIC filters by publication year only, so a window shorter than one whole '
  + 'calendar year cannot be answered. resmon did not widen your window.';

test('a zero says why, on the results row and in the search record', async ({
  win, goto, backendPort, consoleErrors,
}) => {
  expect(await backendPort()).not.toBe('8742');

  const execId = await win.evaluate(async () => {
    const port = (window as unknown as { resmonAPI: { getBackendPort(): string } })
      .resmonAPI.getBackendPort();
    const res = await fetch(`http://127.0.0.1:${port}/api/search/dive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repository: 'eric',
        query: 'reading comprehension',
        keywords: ['reading comprehension'],
        // Two weeks. No whole calendar year fits inside it.
        date_from: '2026-01-01',
        date_to: '2026-01-14',
        max_results: 5,
        ai_enabled: false,
      }),
    });
    if (!res.ok) throw new Error(`dive failed: ${res.status} ${await res.text()}`);
    return (await res.json()).execution_id as number;
  });
  expect(execId).toBeGreaterThan(0);

  const finalStatus = await win.evaluate(async (id) => {
    const port = (window as unknown as { resmonAPI: { getBackendPort(): string } })
      .resmonAPI.getBackendPort();
    const deadline = Date.now() + 90_000;
    let status = 'running';
    while (Date.now() < deadline) {
      const res = await fetch(`http://127.0.0.1:${port}/api/executions/${id}`);
      status = (await res.json()).status;
      if (status !== 'running') return status;
      await new Promise((r) => setTimeout(r, 500));
    }
    return status;
  }, execId);
  expect(finalStatus).toBe('completed');

  // The API's own summary, before any rendering — so a failure downstream is
  // legible as a renderer problem rather than a backend one.
  const outcomes = await win.evaluate(async (id) => {
    const port = (window as unknown as { resmonAPI: { getBackendPort(): string } })
      .resmonAPI.getBackendPort();
    const res = await fetch(`http://127.0.0.1:${port}/api/executions/${id}`);
    return (await res.json()).source_outcomes;
  }, execId);
  console.log('ZERO REASON source_outcomes', JSON.stringify(outcomes));
  expect(outcomes.could_not_answer).toBe(1);
  expect(outcomes.answered).toBe(0);
  expect(outcomes.not_recorded).toBe(0);

  // --- the results row ----------------------------------------------------
  await goto('/results');
  const row = win.locator('tr.clickable-row').first();
  await expect(row).toBeVisible();
  await expect(win.locator('.results-coverage').first())
    .toContainText('1 of 1 sources could not answer');
  await win.screenshot({
    path: path.join(ensureScreenshotDir(), '31-results-zero-reason.png'),
    fullPage: false,
  });

  // --- the link into the search record ------------------------------------
  await win.locator('.results-coverage button', { hasText: 'see the search record' })
    .first().click();
  await expect(win.locator('.search-record')).toBeVisible({ timeout: 20_000 });
  const activeTab = await win.locator('.tab-bar .tab-btn.tab-active').innerText();
  expect(activeTab.trim()).toBe('Search record');

  // The sentence itself, on screen, in the app.
  await expect(win.locator('.record-notes')).toContainText(WINDOW_SENTENCE);
  await expect(win.locator('.search-record .simple-table').first()).toContainText(
    'could not answer this window');
  // Scroll the notes into view first: a screenshot of a viewport that cuts off
  // the sentence is not evidence that the sentence is on screen.
  await win.locator('.record-notes').scrollIntoViewIfNeeded();
  await win.screenshot({
    path: path.join(ensureScreenshotDir(), '32-search-record-zero-reason.png'),
    fullPage: false,
  });

  const errors = consoleErrors.filter((e) => e.route === '/results');
  expect(errors, JSON.stringify(errors, null, 2)).toEqual([]);
});

test('the monitor names the source that could not answer', async ({
  win, goto, backendPort,
}) => {
  expect(await backendPort()).not.toBe('8742');

  // Driven through the Deep Dive form rather than by POSTing to the backend:
  // the Monitor only tracks executions this renderer started, so a run created
  // behind the renderer's back is invisible there — which is correct
  // behaviour and would have made a backend-seeded screenshot meaningless.
  await goto('/dive');

  // The page renders more than one <select> — the saved-configuration loader
  // sits above the form — so this picks the one that actually offers ERIC
  // rather than counting elements.
  await win.locator('select.form-select')
    .filter({ has: win.locator('option[value="eric"]') })
    .selectOption('eric');
  await win.locator('.date-input-group input').first().fill('2026-01-01');
  await win.locator('.date-input-group input').nth(1).fill('2026-01-14');
  await win.locator('.keyword-input-row input').fill('reading comprehension');
  await win.locator('.keyword-input-row button', { hasText: 'Add' }).click();
  await win.locator('button', { hasText: 'Run Deep Dive' }).click();

  await goto('/monitor');
  // The grid is the surface under test, so wait for the source's own row
  // rather than screenshotting whatever the page happens to show first.
  await expect(win.locator('.mon-repo-zero-reason').first())
    .toContainText(WINDOW_SENTENCE, { timeout: 30_000 });
  // A source that could not answer must not be showing a green tick.
  await expect(win.locator('.mon-repo-icon--no_answer').first()).toBeVisible();
  await win.screenshot({
    path: path.join(ensureScreenshotDir(), '33-monitor-zero-reason.png'),
    fullPage: false,
  });
});
