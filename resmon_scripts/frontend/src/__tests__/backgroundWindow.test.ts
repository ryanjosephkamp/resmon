/**
 * The window-behaviour CI job must keep launching the app normally.
 *
 * Both Playwright configs now ask for `RESMON_BACKGROUND_WINDOW=1`, which shows
 * the app's windows inactive and, on macOS, runs the process under the
 * `accessory` activation policy. That is the right default for an automated run
 * on somebody's own Mac — it stops the suite taking the foreground dozens of
 * times — but it is wrong for exactly one job.
 *
 * `ui-smoke.yml`'s **Window behaviour (Electron on macOS)** job exists to watch
 * maximize, focus and stacking. Under the flag no window ever reports focus and
 * the process has no Dock icon and no menu bar, so those assertions stop being
 * about the app that ships — and `window-manager.spec.ts`'s link-window focus
 * arm `test.skip()`s itself when no window reports focus, so the job would stay
 * green having quietly stopped asserting. Nothing in the run output would say
 * so. That is the failure this file prevents.
 *
 * Two halves, because either alone is avoidable:
 *
 *   - `e2e/background-window.ts` throws at config load when the job marker and
 *     the flag are both set, which takes the run down before the first spec.
 *     The cases below drive that function directly.
 *   - the workflow itself is read here, because the throw only fires if the
 *     marker is still in the job. A `env:` block added at the workflow's top
 *     level, or a deleted marker, is how this gets broken by accident, and
 *     neither of those is something the throw can see.
 *
 * This runs in the frontend job on every pull request, which is the point: the
 * suites it protects run on other jobs and some of them not at all in CI.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  BACKGROUND_WINDOW_ENV,
  WINDOW_BEHAVIOR_JOB_ENV,
  requestBackgroundWindows,
} from '../../e2e/background-window';

const WORKFLOW = path.join(
  __dirname, '..', '..', '..', '..', '.github', 'workflows', 'ui-smoke.yml',
);

/** The job key whose subject is the window. */
const WINDOW_JOB = 'window';

/**
 * The lines of one top-level job in a workflow, by its key.
 *
 * A real YAML parser is not a dependency this repository has, and the shape
 * being read is fixed: `jobs:` at column 0, a job key indented two, and the
 * job's body indented more than that. Indentation is enough, and a wrong answer
 * here shows up as a failing case rather than a silent pass — the marker
 * assertion below fails if the slice is empty or picks the wrong job.
 */
function jobBlock(workflow: string, job: string): string[] {
  const lines = workflow.split('\n');
  const start = lines.findIndex((line) => line === `  ${job}:`);
  if (start === -1) return [];
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    // A blank line belongs to whatever block surrounds it.
    if (line.trim() === '') { body.push(line); continue; }
    if (!line.startsWith('    ')) break;
    body.push(line);
  }
  return body;
}

/** Every line of the workflow that is not inside a job — its `on:`, `env:`, and so on. */
function outsideJobs(workflow: string): string[] {
  const lines = workflow.split('\n');
  const jobsAt = lines.indexOf('jobs:');
  return jobsAt === -1 ? lines : lines.slice(0, jobsAt);
}

describe('the window-behaviour job never runs with background windows', () => {
  const workflow = fs.readFileSync(WORKFLOW, 'utf8');

  test('the job declares the marker the Playwright config keys its opt-out on', () => {
    const block = jobBlock(workflow, WINDOW_JOB);
    expect(block.length).toBeGreaterThan(0);
    const marker = block.filter((line) => line.includes(WINDOW_BEHAVIOR_JOB_ENV));
    expect(marker).toEqual([`      ${WINDOW_BEHAVIOR_JOB_ENV}: '1'`]);
  });

  test('the job sets the background-window variable nowhere in its block', () => {
    const offenders = jobBlock(workflow, WINDOW_JOB)
      .filter((line) => line.includes(BACKGROUND_WINDOW_ENV));
    expect(offenders).toEqual([]);
  });

  test('no workflow-level env reaches that job with the variable', () => {
    const offenders = outsideJobs(workflow)
      .filter((line) => line.includes(BACKGROUND_WINDOW_ENV));
    expect(offenders).toEqual([]);
  });
});

describe('requestBackgroundWindows', () => {
  test('asks for background windows on an ordinary run', () => {
    const env: Record<string, string | undefined> = {};
    requestBackgroundWindows(env);
    expect(env[BACKGROUND_WINDOW_ENV]).toBe('1');
  });

  test('leaves the window-behaviour job alone', () => {
    const env: Record<string, string | undefined> = { [WINDOW_BEHAVIOR_JOB_ENV]: '1' };
    requestBackgroundWindows(env);
    expect(env[BACKGROUND_WINDOW_ENV]).toBeUndefined();
  });

  test('keeps an explicit opt-out, so a focus problem can be debugged locally', () => {
    const env: Record<string, string | undefined> = { [BACKGROUND_WINDOW_ENV]: '0' };
    requestBackgroundWindows(env);
    expect(env[BACKGROUND_WINDOW_ENV]).toBe('0');
  });

  test('refuses to run the window-behaviour job with the flag set', () => {
    const env: Record<string, string | undefined> = {
      [WINDOW_BEHAVIOR_JOB_ENV]: '1',
      [BACKGROUND_WINDOW_ENV]: '1',
    };
    expect(() => requestBackgroundWindows(env)).toThrow(/window-behaviour job/);
  });

  test('refuses even when the flag is an explicit off, because the conflict is the bug', () => {
    const env: Record<string, string | undefined> = {
      [WINDOW_BEHAVIOR_JOB_ENV]: '1',
      [BACKGROUND_WINDOW_ENV]: '0',
    };
    expect(() => requestBackgroundWindows(env)).toThrow();
  });
});
