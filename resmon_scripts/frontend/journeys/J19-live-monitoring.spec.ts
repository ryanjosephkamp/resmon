/**
 * J19 Live monitoring — cancelling from the Monitor keeps the work done so far.
 *
 * The register's invariant is "cancelling keeps the work done so far", which is
 * only observable if the run is genuinely in flight when the button is pressed.
 * The authored source this journey runs against accepts the request and holds
 * it open, so the run is really waiting on a source when Cancel is clicked, and
 * the cancel is really cooperative rather than a status flip over a run that had
 * already finished.
 */
import { expect, journey } from './driver';

journey.use({ sourceReply: 'held' });

journey.describe('J19 Live monitoring', () => {
  journey('a run cancelled from the Monitor keeps a report, rather than nothing', async ({ resmon }) => {
    const run = await resmon.runSweep({ sources: ['arxiv', 'springer'], query: 'perovskite', cap: 10 });

    // While it is happening: the Monitor knows about it and says what each
    // source is doing.
    const live = await resmon.readRunPanelOutcomes(run);
    expect(live.map((o) => o.source).sort()).toEqual(['arxiv', 'springer']);

    await resmon.cancelRunFromMonitor(run);
    // Let the held request through, so the worker reaches the point where it
    // can notice the cancel rather than sitting on a socket until the timeout.
    resmon.releaseTheSource();

    const facts = await resmon.waitForRunToSettle(run);
    expect(
      facts.status,
      `a cancelled run settled as "${facts.status}"`,
    ).toBe('cancelled');

    // The whole point: there is still something to read.
    expect(await resmon.reportExists(run), 'the cancelled run has no report at all').toBe(true);
    const sentence = await resmon.readCoverageSentence(run);
    expect(sentence.length).toBeGreaterThan(0);
    expect(sentence, 'the cancelled run lost its denominator').toContain('2 selected sources');

    const outcomes = await resmon.readReportOutcomes(run);
    expect(outcomes.map((o) => o.source).sort()).toEqual(['arxiv', 'springer']);
    for (const outcome of outcomes) {
      expect(outcome.note.length, `${outcome.source} was left with a blank reason`).toBeGreaterThan(0);
    }

    await resmon.takePicture('J19-live-monitoring-cancelled-partial');
    expect(resmon.refusedConnections()).toEqual([]);
  });
});
