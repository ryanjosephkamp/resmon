/**
 * Q4 — does the session-5 failure reproduce?
 *
 * Session 5 drove the renderer with headless Chrome against a served build and
 * reported that the Results report viewer's **Search record** tab "would not
 * activate under headless click automation". That is the single most important
 * fact this spike can return, because if a tab cannot be clicked then a
 * verification layer cannot verify the interface, only the routing.
 *
 * The click here is Playwright's `locator.click()` — a real trusted input event
 * dispatched through Chromium's input pipeline at the element's hit point, not
 * a synthetic `element.click()` or a dispatched `MouseEvent`. That distinction
 * is the whole question: a React `onClick` fires for both, but a page that is
 * covered, scrolled away, or zero-size fails only the first.
 *
 * **Seeding.** An authored Atom feed is served over real loopback HTTP to the
 * real arXiv parser. The actual backend execution must complete and store the
 * fixture paper before the trusted tab click. This is not an arXiv availability
 * test; the scoped source fixture refuses external connections.
 */
import * as path from 'path';
import { test, expect } from '@playwright/test';
import { ensureScreenshotDir } from './fixtures/resmon-app';
import { launchSourceApp } from './fixtures/source-boundary';

test.describe.configure({ mode: 'serial' });

test('Q4: the Search record tab activates under a real Playwright click', async () => {
  const source = await launchSourceApp('paper');
  const { win } = source;
  const consoleErrors: string[] = [];
  win.on('console', (msg) => {
    if (msg.type() === 'error' && win.url().endsWith('#/results')) consoleErrors.push(msg.text());
  });
  win.on('pageerror', (error) => consoleErrors.push(error.message));
  try {
    // --- seed ---------------------------------------------------------------
    const execId = await win.evaluate(async () => {
      const port = (window as unknown as { resmonAPI: { getBackendPort(): string } })
        .resmonAPI.getBackendPort();
      const res = await fetch(`http://127.0.0.1:${port}/api/search/dive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repository: 'arxiv',
          query: 'graph neural network',
          keywords: ['graph neural network'],
          max_results: 3,
          ai_enabled: false,
        }),
      });
      if (!res.ok) throw new Error(`dive failed: ${res.status} ${await res.text()}`);
      return (await res.json()).execution_id as number;
    });
    expect(execId).toBeGreaterThan(0);

    await source.waitForRequest();
    source.release();
    // Require the controlled source execution to finish before testing the tab.
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
    const effect = source.evidence(execId);
    expect(effect.requests).toHaveLength(1);
    expect(effect.requests[0]).toMatchObject({ method: 'GET', status: 200, transport: 'http-response' });
    expect(effect.requests[0].url).toContain('search_query=all%3Agraph+neural+network');
    expect(effect.stored.documents).toHaveLength(1);
    expect(effect.stored.documents[0]).toMatchObject({ external_id: '2609.00001v1', title: 'Authored graph neural network fixture' });

    // --- open the report viewer --------------------------------------------
    await win.evaluate(() => { window.location.hash = '#/results'; });

    const row = win.getByText(`Execution #${execId}`, { exact: true }).locator('xpath=ancestor::tr');
    await expect(row).toBeVisible();
    await row.click();

    const tabBar = win.locator('.tab-bar');
    await expect(tabBar).toBeVisible();

    const recordTab = win.locator('.tab-bar .tab-btn', { hasText: 'Search record' });
    await expect(recordTab).toBeVisible();

    // The state *before* the click, so the assertion after it is a transition
    // rather than a coincidence.
    const classesBefore = await recordTab.getAttribute('class');
    expect(classesBefore).not.toContain('tab-active');

    // --- the click the session-5 note is about ------------------------------
    await recordTab.click();

    const classesAfter = await recordTab.getAttribute('class');
    const activeLabel = await win.locator('.tab-bar .tab-btn.tab-active').innerText();
    const recordPanelCount = await win.locator('.search-record').count();

    // Everything the DOM says about what the click did, printed unconditionally
    // so a failing run in CI carries its own evidence.
    console.log('Q4 DOM AFTER CLICK', JSON.stringify({
      classesBefore, classesAfter, activeLabel, recordPanelCount, finalStatus,
    }));

    expect(classesAfter).toContain('tab-active');
    expect(activeLabel.trim()).toBe('Search record');

    // The tab activating is one thing; the panel it selects rendering is another.
    // `SearchRecord` fetches `/api/executions/{id}/search-record` on mount, so
    // wait for its own container rather than asserting on the tab alone.
    await expect(win.locator('.search-record')).toBeVisible({ timeout: 20_000 });
    await expect(win.locator('.search-record-head')).toBeVisible();

    await win.screenshot({
      path: path.join(ensureScreenshotDir(), '30-search-record-tab.png'),
      fullPage: false,
    });

    expect(consoleErrors).toEqual([]);
  } finally { await source.close(); }
});
