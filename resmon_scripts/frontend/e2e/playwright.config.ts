import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: __dirname,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  // `global-setup.ts` picks and proves the backend's interpreter before the
  // first spec; `completion-guard.ts` turns collected-but-never-run cases into
  // a non-zero exit instead of a green tick over an absence.
  globalSetup: `${__dirname}/global-setup.ts`,
  reporter: [['list'], [`${__dirname}/completion-guard.ts`]],
  // A run can be given a deadline from the environment. The completion guard's
  // own case uses it to produce a genuine "did not run" — a run cut off before
  // its collected cases could report — through `npm run e2e:review`, which is
  // the entry point the guard has to reach as much as `npm run e2e` does.
  globalTimeout: process.env.RESMON_E2E_GLOBAL_TIMEOUT
    ? Number(process.env.RESMON_E2E_GLOBAL_TIMEOUT)
    : undefined,
  outputDir: `${__dirname}/test-results`,
});
