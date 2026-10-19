import { defineConfig } from '@playwright/test';
import { requestBackgroundWindows, requestHiddenWindows } from '../e2e/background-window';

// Show the app's windows without taking the foreground. A journey run launches
// Electron dozens of times and each launch used to pull the keyboard away from
// whoever was at the machine. See `../e2e/background-window.ts`; the journey
// drivers inherit this through `launchEnv`, so nothing there had to change.
requestBackgroundWindows();

// And keep them off the screen entirely. The background flag above stops the
// foreground grab; it does not stop the window appearing, which was measured
// with the CoreGraphics on-screen window list. A journey run launches the app
// dozens of times, so for this suite the window is never shown at all. Nothing
// in `drivers/session.ts` reads the screen. `RESMON_HIDDEN_WINDOW=0` brings the
// windows back for a run you want to watch.
requestHiddenWindows();

/**
 * The journey suite's own runner.
 *
 * Separate from `e2e/playwright.config.ts` on purpose: `e2e/` verifies *this*
 * checkout and is where a spec goes when it is about a change to it. This
 * directory verifies a *build*, which may be another one, and its pass or fail
 * is a statement about the parity register rather than about a diff.
 *
 * `fullyParallel: false` and one worker, as next door: each journey launches a
 * real Electron and a real backend, and two of them at once on a CI runner is
 * how a suite becomes flaky for reasons that have nothing to do with the app.
 */
export default defineConfig({
  testDir: __dirname,
  // A journey is a whole user path — launch, run, wait for a sweep to settle,
  // read a report — so the per-case budget is larger than the smoke suite's.
  //
  // **Five minutes, which is where it started.** It was briefly ten, because
  // the backup row exceeded five on a runner while taking ten seconds on a
  // laptop; the row then ate the ten as well. Raising a budget to cover a hang
  // buys a slower red run and nothing else. The calls that had no deadline of
  // their own now have one — see `CLOSE_DEADLINE_MS` and `API_DEADLINE_MS` in
  // `drivers/session.ts` — so the worst case is a handful of named failures
  // well inside this, rather than a wall with nothing written on it.
  timeout: 300_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  // No retries. A journey that only passes sometimes is a journey that is
  // telling you something, and a retry is how that stops being heard.
  retries: 0,
  globalSetup: `${__dirname}/global-setup.ts`,
  reporter: [['list'], ['html', { outputFolder: `${__dirname}/report`, open: 'never' }]],
  globalTimeout: process.env.RESMON_JOURNEY_GLOBAL_TIMEOUT
    ? Number(process.env.RESMON_JOURNEY_GLOBAL_TIMEOUT)
    : undefined,
  outputDir: `${__dirname}/test-results`,
});
