import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: __dirname,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  outputDir: `${__dirname}/test-results`,
});
