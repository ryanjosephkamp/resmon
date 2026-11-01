/**
 * Launch the app's windows in the background during an automated run.
 *
 * Both suites launch the real Electron app over and over. Until now every
 * launch came to the front and took the keyboard, so a journey run made the
 * machine unusable for as long as it lasted. `RESMON_BACKGROUND_WINDOW=1` tells
 * `electron/main.ts` to show its windows with `showInactive()` and, on macOS,
 * to run under the `accessory` activation policy. `showInactive()` is the half
 * that stops the foreground grab; the policy is what keeps the Dock icon and
 * the menu bar away. The table above `setActivationPolicy` in
 * `electron/main.ts` has the measurement that separates them.
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
 * what the window does: maximize, focus, stacking. A run with this flag has
 * none of that to watch — no window ever reports focus, and the app has no
 * Dock icon and no menu bar — so a focus assertion against it is a statement
 * about something nobody ships. Worse than failing: `window-manager.spec.ts`'s
 * link-window focus arm `test.skip()`s when no window reports focus, so the
 * job would go green having quietly stopped asserting. That is the failure mode
 * that is worst to find late.
 *
 * So that job sets `RESMON_WINDOW_BEHAVIOR_JOB=1`, this module declines to set
 * the flag when it sees it, and — the part that matters — it **throws** if the
 * flag is set anyway. A config module that throws takes the whole run down
 * before the first spec, so the next person who adds a global `env:` block to
 * that workflow gets a red run naming the conflict instead of a quiet change of
 * subject. `tests/backgroundWindow.test.ts` is the static half of the
 * same guard and runs on every pull request.
 */

/** The variable `electron/main.ts` reads. */
export const BACKGROUND_WINDOW_ENV = 'RESMON_BACKGROUND_WINDOW';

/**
 * The second flag: no window on the screen at all.
 *
 * `RESMON_BACKGROUND_WINDOW` keeps the keyboard where it was, and that is all
 * it does — `showInactive()` still puts the window up, which was measured with
 * the CoreGraphics on-screen window list rather than inferred from the method
 * name: one on-screen window per launch, full size, over whatever the person
 * was reading. This flag tells `electron/main.ts` not to call `show()` at all.
 *
 * It composes with the first rather than replacing it, and the two are
 * separate because they cost different things. The background flag is free:
 * the same window, not focused. This one is not — a run under it cannot
 * observe anything that needs a window on a screen, and anybody debugging by
 * watching the app has nothing to watch. So it is opted into per suite.
 */
export const HIDDEN_WINDOW_ENV = 'RESMON_HIDDEN_WINDOW';

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
      + 'stacking — and a run with background windows has none of that to test: '
      + 'no window reports focus, so the link-window focus arm skips itself and '
      + 'the job goes green having stopped asserting. Remove the '
      + 'background-window variable from that job rather than from this check.',
    );
  }
  if (isWindowBehaviorJob) return;
  // An explicit value from the caller wins, including an explicit "0": someone
  // debugging a focus problem on their own machine needs a way to get the old
  // behaviour back without editing this file.
  if (env[BACKGROUND_WINDOW_ENV] === undefined) env[BACKGROUND_WINDOW_ENV] = '1';
}

/**
 * Ask for *no* window on the screen for this run, unless the run is the one
 * job that must not have that.
 *
 * Called from `journeys/playwright.config.ts` only. The journey suite is the
 * one that runs over and over while somebody is working at the machine, and
 * its specs go through `drivers/session.ts`, which reads the app over IPC and
 * the backend over HTTP — none of it needs the window to be on a screen.
 *
 * The same exemption as `requestBackgroundWindows`, and for a stronger reason:
 * the window-behaviour job watches maximize, focus and stacking, and under
 * this flag there is no window on the screen to watch at all. It would still
 * go green. So the job declines the flag, and the throw is here for the case
 * that matters — somebody handing the flag to that job from a workflow `env:`
 * block, where the decline alone would be silent.
 *
 * @throws if the window-behaviour job is somehow also asking for the flag.
 */
export function requestHiddenWindows(
  env: Record<string, string | undefined> = process.env,
): void {
  const isWindowBehaviorJob = env[WINDOW_BEHAVIOR_JOB_ENV] === '1';
  if (isWindowBehaviorJob && env[HIDDEN_WINDOW_ENV] !== undefined) {
    throw new Error(
      `${WINDOW_BEHAVIOR_JOB_ENV}=1 and ${HIDDEN_WINDOW_ENV}=`
      + `${JSON.stringify(env[HIDDEN_WINDOW_ENV])} are set together. `
      + 'The window-behaviour job tests what the window does — maximize, '
      + 'focus, stacking — and under this flag no window reaches the screen '
      + 'at all, so that job would go green having stopped asserting. Remove '
      + 'the hidden-window variable from that job rather than from this check.',
    );
  }
  if (isWindowBehaviorJob) return;
  // Explicit wins, including "0": `RESMON_HIDDEN_WINDOW=0 npm run journeys`
  // is how someone watches a journey run happen.
  if (env[HIDDEN_WINDOW_ENV] === undefined) env[HIDDEN_WINDOW_ENV] = '1';
}
