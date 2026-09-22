/**
 * J03 Routines — activation and deactivation change the schedule, not the
 * routine; an inline toggle survives a reload; a fire is a full execution with
 * its own report.
 *
 * **What this row cannot observe, stated here rather than in a footnote.**
 * `electron/main.ts` spawns the backend with `RESMON_DISABLE_SCHEDULER=1`, on
 * purpose: the launchd daemon is the sole scheduler owner, and two APScheduler
 * instances over one SQLite jobstore is the dual-scheduler race that dropped
 * fires. So no fire in this suite comes from a clock. The fire below is the
 * routine run once through its own endpoint — which is the "or Run now" arm of
 * the register's own steps — and what it establishes is that a fire produces a
 * full execution with a report attributed to the routine. That APScheduler adds
 * and removes the job is `test_routine_scheduler_sync.py`'s and
 * `test_e2e_routine_fires.py`'s, and this spec does not pretend otherwise.
 */
import { expect, journey } from './driver';

const NAME = 'journey routine J03';

journey.describe('J03 Routines', () => {
  journey('activate, fire, toggle, reload, deactivate — and the routine survives all of it', async ({ resmon }) => {
    await resmon.createRoutine({
      name: NAME,
      // Nine in the morning, every day: a schedule that is written down rather
      // than one relative to now, so the calendar row can assert against it too.
      cron: '0 9 * * *',
      sources: ['arxiv'],
      keywords: ['perovskite'],
    });

    await resmon.open('Routines');
    expect(await resmon.listRoutineNames()).toContain(NAME);
    expect((await resmon.readRoutine(NAME)).active, 'a new routine starts inactive').toBe(false);

    await resmon.activateRoutine(NAME);
    expect((await resmon.readRoutine(NAME)).active).toBe(true);

    // A fire is a whole execution, with its own report — not a status flip.
    const fired = await resmon.fireRoutineNow(NAME);
    const facts = await resmon.waitForRunToSettle(fired);
    expect(facts.status).toBe('completed');
    expect(await resmon.reportExists(fired), 'a fire produced no report').toBe(true);
    const row = await resmon.backend.execution(fired);
    expect(row.execution_type, 'the fire was not recorded as the routine firing').toBe('automated_sweep');

    // The inline toggle, and the thing that actually failed in the field: a
    // switch that flips on screen and is not there when you come back.
    const before = (await resmon.readRoutine(NAME)).desktopNotification;
    await resmon.toggleDesktopNotification(NAME);
    expect((await resmon.readRoutine(NAME)).desktopNotification).toBe(!before);
    await resmon.reopenTheApp();
    expect(
      (await resmon.readRoutine(NAME)).desktopNotification,
      'the toggle did not survive a reload',
    ).toBe(!before);

    await resmon.deactivateRoutine(NAME);
    const after = await resmon.readRoutine(NAME);
    expect(after.active).toBe(false);
    expect(
      await resmon.listRoutineNames(),
      'deactivating deleted the routine instead of pausing it',
    ).toContain(NAME);
    // And the run it already produced is still there: deactivation is not a
    // retraction of history.
    expect((await resmon.backend.executions()).some((e) => e.id === fired.id)).toBe(true);

    await resmon.takePicture('J03-routines-deactivated-and-kept');
    expect(resmon.refusedConnections()).toEqual([]);
  });
});
