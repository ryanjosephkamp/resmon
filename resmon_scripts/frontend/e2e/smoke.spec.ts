/**
 * One smoke test per screen: the screen loads at its own address, Chromium
 * logged no error, and a screenshot lands in `e2e/screenshots/`.
 *
 * The screen list is `e2e/screens.ts`, which **imports** the list
 * `atlas/src/screenPaths.ts` holds to the router. A screen that exists is
 * therefore a screen with a smoke test.
 */
import * as path from 'path';
import {
  test, expect, ensureScreenshotDir, isOwnOrigin, fittedWindowSize, heldScreen,
  WINDOW_WIDTH, WINDOW_HEIGHT,
} from './fixtures/resmon-app';
import { SCREENS } from './screens';

test.use({ ui: 'atlas' });

test.describe('screen smoke', () => {
  test.describe.configure({ mode: 'serial' });

  for (const screen of SCREENS) {
    test(`${screen.name} (${screen.path}) loads with no console errors`, async ({
      win, goto, consoleErrors, failedRequests, backendPort,
    }) => {
      // The app is never allowed to have attached to the launchd daemon.
      // 8742 is a live process over a different database; if the suite is
      // talking to it, every assertion below is about the wrong corpus.
      expect(await backendPort()).not.toBe('8742');

      await goto(screen.path);

      // Still at its own address. Atlas sends an address it does not route
      // back to Today, where the frame and Today's own content paint
      // perfectly, so this is the assertion that makes the CI job fail on a
      // broken route; `ui-smoke.yml`'s `break_route` input demonstrates it.
      const at = await win.evaluate(() => window.location.hash.replace(/^#/, '').split('?')[0]);
      expect(at, `${screen.path} did not stay at its own address`).toBe(screen.path);

      // `main.stage` holds only what the router rendered for the screen; the
      // top bar is outside it, so a screen that drew nothing leaves it empty.
      const routed = await win.locator('main.stage').innerText();
      expect(
        routed.trim().length,
        `${screen.path} rendered an empty <main class="stage">`,
      ).toBeGreaterThan(0);

      const dir = ensureScreenshotDir();
      await win.screenshot({
        path: path.join(dir, `${screen.slug}.png`),
        fullPage: false,
      });

      // Both assertions below are scoped to resmon's own origins, and that
      // boundary was put here by three failing runs rather than chosen up
      // front. `isOwnOrigin` in the fixture carries the reasoning, the two
      // third-party sources, and what the scoping can no longer see.
      const errorsHere = consoleErrors.filter((e) => e.route === screen.path);
      const ourErrors = errorsHere.filter((e) => isOwnOrigin(e.location));
      const theirErrors = errorsHere.filter((e) => !isOwnOrigin(e.location));
      if (theirErrors.length > 0) {
        console.log(`third-party console errors while on ${screen.path} (not asserted):`,
          JSON.stringify(theirErrors, null, 2));
      }
      expect(
        ourErrors,
        `resmon's own console errors on ${screen.path}:\n${JSON.stringify(ourErrors, null, 2)}`,
      ).toEqual([]);

      const failedHere = failedRequests.filter((r) => r.route === screen.path);
      const ourFailures = failedHere.filter((r) => isOwnOrigin(r.url));
      const theirFailures = failedHere.filter((r) => !isOwnOrigin(r.url));
      if (theirFailures.length > 0) {
        console.log(`third-party requests failed while on ${screen.path} (not asserted):`,
          JSON.stringify(theirFailures, null, 2));
      }
      expect(
        ourFailures,
        `resmon's own requests failed on ${screen.path}:\n${JSON.stringify(ourFailures, null, 2)}`,
      ).toEqual([]);

      // Recorded in the report as the caption for every screenshot — and
      // measured against what the display allows rather than against the
      // requested numbers. The macOS CI runner's work area is 1024x684, so a
      // literal 1440 here failed on a runner where the app was correct. See
      // `fittedWindowSize` in the fixture; a run held to a screen with
      // `RESMON_E2E_SCREEN` asks for a window no larger than it.
      const viewport = await win.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
      const workArea = await win.evaluate(() => ({
        width: window.screen.availWidth, height: window.screen.availHeight,
      }));
      const held = heldScreen();
      const fitted = fittedWindowSize(held
        ? { width: Math.min(workArea.width, held[0]), height: Math.min(workArea.height, held[1]) }
        : workArea);
      if (fitted.clamped && screen.path === SCREENS[0].path) {
        console.log('SMOKE WINDOW CLAMPED', JSON.stringify({ workArea, fitted }),
          `— screenshots on this run are smaller than the requested `
          + `${WINDOW_WIDTH}x${WINDOW_HEIGHT}`);
      }
      expect(viewport.w).toBe(fitted.width);
      expect(viewport.h).toBeLessThanOrEqual(fitted.height);
    });
  }
});
