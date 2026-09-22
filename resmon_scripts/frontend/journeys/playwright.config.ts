import { defineConfig } from '@playwright/test';

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
