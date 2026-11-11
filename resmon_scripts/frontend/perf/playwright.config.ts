import { defineConfig } from '@playwright/test';
import { requestBackgroundWindows } from '../e2e/background-window';

// Shown, but without taking the foreground. Hidden windows are not used here
// the way the journey suite uses them: Chromium may throttle a window that is
// never shown, and a timing taken from a throttled renderer is not the app's.
requestBackgroundWindows();

/**
 * The interface half of the performance harness (`resmon_scripts/perf/`).
 *
 * Not a test suite: one case that launches the app several times and writes
 * what it measured to `RESMON_PERF_OUT`. `python -m perf` runs it and turns
 * the samples into medians and 95th percentiles. One worker, no retries, and
 * nothing else running, because every number here is a duration.
 */
export default defineConfig({
  testDir: __dirname,
  testMatch: /.*\.perf\.ts$/,
  timeout: 60 * 60 * 1000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: `${__dirname}/test-results`,
});
