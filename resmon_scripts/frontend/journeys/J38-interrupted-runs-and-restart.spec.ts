/**
 * J38 Interrupted runs and Restart — a run whose process died says so on the
 * next start, Restart makes a new one, and the old one keeps what it had.
 *
 * The existing Electron spec next door seeds an `interrupted` row into the
 * database before launching, and says plainly that what it does not establish
 * is how a row comes to be interrupted. This row is the journey, so it produces
 * one: a sweep is started against a source that holds its reply, the backend is
 * killed outright while that run is still in flight, and the app is opened
 * again. Nothing writes the status — `_reconcile_executions_on_startup` decides
 * it, from a pid that is no longer there.
 *
 * The invariant is honesty on restart: nothing is reported as still running
 * when its pid is gone.
 */
import { expect, journey } from './driver';

journey.use({ sourceReply: 'held' });

journey.describe('J38 Interrupted runs and Restart', () => {
  journey('a killed run reads Interrupted with a reason, Restart makes a new run, and the old one survives', async ({ resmon }) => {
    const run = await resmon.runSweep({ sources: ['arxiv'], query: 'perovskite', cap: 10 });
    // Still in flight: the source is holding the reply, so the row is running
    // and owned by a process that is about to stop existing.
    expect((await resmon.backend.execution(run)).status).toBe('running');

    await resmon.killTheBackend();
    await resmon.reopenTheApp();

    // The start that followed the death decided this, not the suite.
    const row = await resmon.backend.execution(run);
    expect(row.status, 'a run whose process is gone is still reported as running').toBe('interrupted');
    expect(String(row.interrupted_reason ?? ''), 'the run stopped for no recorded reason').not.toBe('');

    const shown = await resmon.readInterruptedRow(run);
    expect(shown.badge.toLowerCase()).toContain('interrupted');
    // The stored token is rendered as a sentence, not shown raw.
    expect(shown.note.length, 'the row gives no reason under the badge').toBeGreaterThan(0);
    expect(shown.note, 'the row shows the stored token instead of a sentence')
      .not.toBe(String(row.interrupted_reason));
    console.log(`[J38] reason "${row.interrupted_reason}" renders as: ${shown.note}`);

    const restarted = await resmon.restartRun(run);
    expect(restarted.id, 'Restart reused the run it was restarting').not.toBe(run.id);
    expect(
      (await resmon.backend.execution(restarted)).restarted_from,
      'the new run does not record where it came from',
    ).toBe(run.id);

    // And the old one is still there, still interrupted, still its own row.
    const old = await resmon.backend.execution(run);
    expect(old.status).toBe('interrupted');
    expect((await resmon.backend.executions()).some((e) => e.id === run.id)).toBe(true);

    await resmon.takePicture('J38-interrupted-and-restarted');
    expect(resmon.refusedConnections()).toEqual([]);
  });
});
