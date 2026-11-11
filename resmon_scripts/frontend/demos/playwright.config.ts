import { defineConfig } from '@playwright/test';
import { requestBackgroundWindows } from '../e2e/background-window';

// Shown, so Chromium paints every frame of the recording, but without taking
// the foreground from whoever is at the machine.
requestBackgroundWindows();

/**
 * The demo recordings: not a test suite. Each case drives the real app through
 * one task at a person's pace and films it; `media.ts` then makes the GIFs and
 * the tour video from the takes. See README.md beside this file.
 */
export default defineConfig({
  testDir: __dirname,
  testMatch: /.*\.demo\.ts$/,
  timeout: 10 * 60 * 1000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: `${__dirname}/test-results`,
});
