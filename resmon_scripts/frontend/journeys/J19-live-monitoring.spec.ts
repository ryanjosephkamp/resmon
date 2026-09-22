/**
 * J19 Live monitoring — cancelling from the Monitor keeps the work done so far
 * visible, and invents no completion.
 *
 * The authored source holds its reply, so the run is genuinely in flight when
 * Cancel is pressed and the cancel is really cooperative rather than a status
 * flip over a run that had already finished.
 *
 * **What this row found, and why the assertion is shaped the way it is.** The
 * parity register's J19 says a cancelled run has "a partial report, not
 * nothing". At this base, a sweep cancelled during the query stage writes no
 * report document: `result_path` and `log_path` are both null and
 * `/api/executions/{id}/report` has no text. What it *does* keep is the
 * read-time coverage account, and that account is careful in exactly the way
 * the invariant asks for — the source that answered is recorded as having
 * answered with its count, the source that was never reached is
 * "outcome not recorded" rather than a silent zero, and the account says out
 * loud that the run is not completed and its coverage may be incomplete.
 *
 * So this asserts the invariant ("no fabricated completion; source failures
 * stay visible; the work done so far is not thrown away") and *reports* the
 * absent report document rather than asserting either way. Whether the register
 * or the app is wrong about that sentence is the lead's call, not this suite's:
 * a journey observes, it does not fix.
 */
import { expect, journey } from './driver';

journey.use({ sourceReply: 'held' });

journey.describe('J19 Live monitoring', () => {
  journey('a run cancelled from the Monitor keeps what it had, and claims nothing it did not', async ({ resmon }) => {
    const run = await resmon.runSweep({ sources: ['arxiv', 'springer'], query: 'perovskite', cap: 10 });

    // While it is happening: the Monitor knows about it and shows both sources.
    const live = await resmon.readRunPanelOutcomes(run);
    expect(live.map((o) => o.source).sort()).toEqual(['arxiv', 'springer']);

    await resmon.cancelRunFromMonitor(run);
    // Let the held request through, so the worker reaches the point where it
    // can notice the cancel rather than sitting on a socket until the timeout.
    resmon.releaseTheSource();

    const facts = await resmon.waitForRunToSettle(run);
    expect(facts.status, `a cancelled run settled as "${facts.status}"`).toBe('cancelled');

    // No fabricated completion: the run does not report itself as finished, and
    // its account says so rather than quietly presenting partial coverage as
    // the whole picture.
    const outcomes = await resmon.readReportOutcomes(run);
    const sentence = await resmon.readCoverageSentence(run);
    expect(sentence, 'the cancelled run lost its denominator').toContain('2 selected sources');
    expect(outcomes.map((o) => o.source).sort()).toEqual(['arxiv', 'springer']);
    for (const outcome of outcomes) {
      expect(
        outcome.note.length,
        `${outcome.source} was left with a blank cell instead of a stated outcome`,
      ).toBeGreaterThan(0);
    }

    // The work done so far is kept: the source that answered before the cancel
    // is recorded as having answered, not reset to zero along with the run.
    const answered = outcomes.find((o) => o.source === 'arxiv')!;
    expect(answered.label, 'the source that answered before the cancel lost its outcome')
      .toContain('answered');

    // And the source that was never reached is explicitly unrecorded rather
    // than reported as having found nothing — which is the difference the whole
    // coverage feature exists to keep.
    const unreached = outcomes.find((o) => o.source === 'springer')!;
    expect(unreached.note.toLowerCase()).toContain('not recorded');
    expect(unreached.label.toLowerCase()).toContain('unknown');

    // Reported, not asserted: at this base a cancelled sweep has no report
    // document, which is not what the register's J19 sentence describes. The
    // handback carries it as a finding; this row does not decide it.
    const hasReport = await resmon.reportExists(run);
    const row = await resmon.backend.execution(run);
    console.log(`[J19] cancelled run: report document ${hasReport ? 'present' : 'ABSENT'}; `
      + `result_path=${row.result_path}; log_path=${row.log_path}; `
      + `execution result_count=${row.result_count}; `
      + `coverage says ${JSON.stringify(outcomes.map((o) => [o.source, o.label]))}`);
    if (!hasReport) {
      console.log('[J19] NOT VERIFIED: "the cancelled run has a partial report" — '
        + 'no report document exists for a sweep cancelled during the query stage. '
        + 'The read-time coverage account is what survives, and it is asserted above.');
    }

    await resmon.takePicture('J19-live-monitoring-cancelled');
    expect(resmon.refusedConnections()).toEqual([]);
  });
});
