/**
 * One smoke test per route: the page loads, Chromium logged no error, and a
 * screenshot lands in `e2e/screenshots/`.
 *
 * The route list is `e2e/routes.ts`, copied by hand from `App.tsx` — see the
 * comment at the top of that file for why it is a copy and what that costs.
 */
import * as path from 'path';
import {
  test, expect, ensureScreenshotDir, isOwnOrigin, WINDOW_WIDTH, WINDOW_HEIGHT,
} from './fixtures/resmon-app';
import { ROUTES } from './routes';

test.describe('route smoke', () => {
  test.describe.configure({ mode: 'serial' });

  for (const route of ROUTES) {
    test(`${route.name} (${route.path}) loads with no console errors`, async ({
      win, goto, consoleErrors, failedRequests, backendPort,
    }) => {
      // The app is never allowed to have attached to the launchd daemon.
      // 8742 is a live process over a different database; if the suite is
      // talking to it, every assertion below is about the wrong corpus.
      expect(await backendPort()).not.toBe('8742');

      await goto(route.path);

      if (route.redirectsTo) {
        expect(win.url()).toContain(`#${route.redirectsTo}`);
      }

      // `.app-main` is the shell — header plus the outlet. It is present on
      // every hash, including one that matches no route at all, so it is
      // necessary and nowhere near sufficient.
      await expect(win.locator('.app-main')).toBeVisible();

      // `main.main-content` holds *only* what `<Routes>` rendered (see
      // `Layout/MainContent.tsx`), so an unmatched route leaves it empty while
      // the rest of the app still paints perfectly. An earlier version of this
      // spec asserted on `body` instead and would have passed on a route that
      // rendered nothing — the sidebar's own text was enough to satisfy it.
      // This is the assertion that makes the CI job fail on a broken route,
      // and `ui-smoke.yml`'s `break_route` input demonstrates exactly that.
      const routed = await win.locator('main.main-content').innerText();
      expect(
        routed.trim().length,
        `route ${route.path} rendered an empty <main class="main-content">`,
      ).toBeGreaterThan(0);

      const dir = ensureScreenshotDir();
      await win.screenshot({
        path: path.join(dir, `${route.slug}.png`),
        fullPage: false,
      });

      // Both assertions below are scoped to resmon's own origins, and that
      // boundary was put here by three failing runs rather than chosen up
      // front. `isOwnOrigin` in the fixture carries the reasoning, the two
      // third-party sources, and what the scoping can no longer see.
      const errorsHere = consoleErrors.filter((e) => e.route === route.path);
      const ourErrors = errorsHere.filter((e) => isOwnOrigin(e.location));
      const theirErrors = errorsHere.filter((e) => !isOwnOrigin(e.location));
      if (theirErrors.length > 0) {
        console.log(`third-party console errors while on ${route.path} (not asserted):`,
          JSON.stringify(theirErrors, null, 2));
      }
      expect(
        ourErrors,
        `resmon's own console errors on ${route.path}:\n${JSON.stringify(ourErrors, null, 2)}`,
      ).toEqual([]);

      const failedHere = failedRequests.filter((r) => r.route === route.path);
      const ourFailures = failedHere.filter((r) => isOwnOrigin(r.url));
      const theirFailures = failedHere.filter((r) => !isOwnOrigin(r.url));
      if (theirFailures.length > 0) {
        console.log(`third-party requests failed while on ${route.path} (not asserted):`,
          JSON.stringify(theirFailures, null, 2));
      }
      expect(
        ourFailures,
        `resmon's own requests failed on ${route.path}:\n${JSON.stringify(ourFailures, null, 2)}`,
      ).toEqual([]);

      // Recorded in the report as the caption for every screenshot.
      const viewport = await win.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
      expect(viewport.w).toBe(WINDOW_WIDTH);
      expect(viewport.h).toBeLessThanOrEqual(WINDOW_HEIGHT);
    });
  }
});
