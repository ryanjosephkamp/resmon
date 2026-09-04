/**
 * Q3 — can a per-page console error and a per-page failed request be captured?
 *
 * The two collectors live in the launch fixture and are attached before the
 * first navigation. This file provokes one of each and proves the collectors
 * see them, because a collector that has never caught anything is not evidence
 * that it would.
 *
 * The provocation is deliberately a *real* application failure rather than a
 * hand-rolled `console.error`: `page.route()` aborts the Analytics page's own
 * data fetch, which is exactly the shape of the failure a smoke suite exists to
 * catch — a page whose backend call does not come back. One provocation
 * produces both signals, since an aborted request fires `requestfailed` and the
 * renderer's unhandled rejection surfaces as a page error.
 */
import { test, expect } from './fixtures/resmon-app';

test.describe.configure({ mode: 'serial' });

test('Q3: an aborted backend call is captured as a failed request', async ({
  win, goto, failedRequests, consoleErrors, backendPort,
}) => {
  expect(await backendPort()).not.toBe('8742');

  // Start somewhere else so the Analytics fetch happens after the route is armed.
  await goto('/');

  await win.route('**/api/analytics/**', (route) => route.abort('failed'));

  const before = failedRequests.length;
  await goto('/analytics');
  // The page retries nothing, so one navigation is enough; give the abort a
  // moment to propagate to the collector.
  await win.waitForTimeout(1500);

  const provoked = failedRequests.slice(before);
  console.log('Q3 FAILED REQUESTS', JSON.stringify(provoked, null, 2));
  expect(provoked.length).toBeGreaterThan(0);
  expect(provoked.some((r) => r.url.includes('/api/analytics/'))).toBe(true);
  expect(provoked.every((r) => r.route === '/analytics')).toBe(true);

  await win.unroute('**/api/analytics/**');

  // And a console error, captured with its source location. Raised from the
  // page rather than by the app so the assertion is about the collector, not
  // about a bug in resmon.
  const errorsBefore = consoleErrors.length;
  await win.evaluate(() => {
    console.error('e2e-provoked-console-error');
  });
  await win.waitForTimeout(300);
  const provokedErrors = consoleErrors.slice(errorsBefore);
  console.log('Q3 CONSOLE ERRORS', JSON.stringify(provokedErrors, null, 2));
  expect(provokedErrors.some((e) => e.text.includes('e2e-provoked-console-error'))).toBe(true);
  expect(provokedErrors[0].route).toBe('/analytics');
  expect(provokedErrors[0].location).not.toBe('');
});

test('Q3: an uncaught renderer exception is captured as a page error', async ({
  win, goto, consoleErrors,
}) => {
  await goto('/watchdog');
  const before = consoleErrors.length;
  // `pageerror`, not `console`. Without the separate listener in the fixture a
  // React render crash would leave the console collector empty and the suite
  // green.
  await win.evaluate(() => {
    setTimeout(() => { throw new Error('e2e-provoked-uncaught'); }, 0);
  });
  await win.waitForTimeout(500);
  const provoked = consoleErrors.slice(before);
  console.log('Q3 PAGE ERRORS', JSON.stringify(provoked, null, 2));
  expect(provoked.some((e) => e.text.includes('[pageerror] e2e-provoked-uncaught'))).toBe(true);
});
