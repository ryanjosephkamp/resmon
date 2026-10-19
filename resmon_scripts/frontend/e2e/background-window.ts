/**
 * Launch the app's windows in the background during an automated run.
 *
 * Both suites launch the real Electron app over and over. Until now every
 * launch came to the front and took the keyboard, so a journey run made the
 * machine unusable for as long as it lasted. `RESMON_BACKGROUND_WINDOW=1` tells
 * `electron/main.ts` to show its windows inactive and, on macOS, to run under
 * the `accessory` activation policy so the process never becomes active at all.
 *
 * The flag is set **here, in the Playwright config modules**, rather than in a
 * launch driver. A config module is evaluated in the runner and in every worker
 * process before any test, and both suites build the app's environment by
 * copying the ambient one (`launchEnv` in `fixtures/resmon-app.ts`), so setting
 * it on `process.env` is enough to reach the launch. Nothing in the drivers had
 * to change.
 *
 * ## The exception, and why it is a thrown error rather than a comment
 *
 * `ui-smoke.yml`'s **Window behaviour (Electron on macOS)** job exists to watch
 * what the window does: maximize, focus, stacking. An app under the `accessory`
 * policy is a different app for exactly those purposes — it has no Dock icon,
 * it does not activate, and a focus assertion against it is a statement about
 * something nobody ships. If that job ever inherited this flag it would keep
 * passing while testing the wrong thing, which is the failure mode that is
 * worst to find late.
 *
 * So that job sets `RESMON_WINDOW_BEHAVIOR_JOB=1`, this module declines to set
 * the flag when it sees it, and — the part that matters — it **throws** if the
 * flag is set anyway. A config module that throws takes the whole run down
 * before the first spec, so the next person who adds a global `env:` block to
 * that workflow gets a red run naming the conflict instead of a quiet change of
 * subject. `src/__tests__/backgroundWindow.test.ts` is the static half of the
 * same guard and runs on every pull request.
 */

/** The variable `electron/main.ts` reads. */
export const BACKGROUND_WINDOW_ENV = 'RESMON_BACKGROUND_WINDOW';

/**
 * The marker the window-behavior CI job sets to identify itself. Any run that
 * carries it is a run whose subject is the window, and it never gets the flag.
 */
export const WINDOW_BEHAVIOR_JOB_ENV = 'RESMON_WINDOW_BEHAVIOR_JOB';

/**
 * Ask for background windows for this run, unless the run is the one job that
 * must not have them.
 *
 * Called for its effect on `process.env` from both Playwright config modules.
 * Exported with an injectable environment so the guard test can drive it
 * without touching the real one.
 *
 * @throws if the window-behavior job is somehow also asking for the flag.
 */
export function requestBackgroundWindows(
  env: Record<string, string | undefined> = process.env,
): void {
  const isWindowBehaviorJob = env[WINDOW_BEHAVIOR_JOB_ENV] === '1';
  if (isWindowBehaviorJob && env[BACKGROUND_WINDOW_ENV] !== undefined) {
    throw new Error(
      `${WINDOW_BEHAVIOR_JOB_ENV}=1 and ${BACKGROUND_WINDOW_ENV}=`
      + `${JSON.stringify(env[BACKGROUND_WINDOW_ENV])} are set together. `
      + 'The window-behaviour job tests what the window does — maximize, focus, '
      + 'stacking — and an app running under the macOS accessory activation '
      + 'policy has none of that to test. Remove the background-window variable '
      + 'from that job rather than from this check.',
    );
  }
  if (isWindowBehaviorJob) return;
  // An explicit value from the caller wins, including an explicit "0": someone
  // debugging a focus problem on their own machine needs a way to get the old
  // behaviour back without editing this file.
  if (env[BACKGROUND_WINDOW_ENV] === undefined) env[BACKGROUND_WINDOW_ENV] = '1';
}
