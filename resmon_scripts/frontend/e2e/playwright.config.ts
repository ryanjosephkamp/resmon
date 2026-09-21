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
  outputDir: `${__dirname}/test-results`,
});
