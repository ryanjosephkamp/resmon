/**
 * J29 Recorded-source coverage — the live run panel and the report's coverage
 * sentence say the same thing about the same run.
 *
 * Two surfaces, one set of facts. The defect this guards against is not that
 * either surface is wrong on its own; it is that they are computed in different
 * places and can drift, so a person watching a sweep and a person reading its
 * report get two different accounts of who answered. The run is deliberately
 * mixed — one source answers, one could not be asked at all — because two
 * surfaces agreeing about a run where everything worked establishes very little.
 */
import { expect, journey } from './driver';

journey.describe('J29 Recorded-source coverage', () => {
  journey('the run panel and the report agree, and the source that could not answer is named in both', async ({ resmon }) => {
    const run = await resmon.runSweep({ sources: ['arxiv', 'springer'], query: 'perovskite', cap: 10 });
    expect((await resmon.waitForRunToSettle(run)).status).toBe('completed');

    const panel = await resmon.readRunPanelOutcomes(run);
    const report = await resmon.readReportOutcomes(run);
    const sentence = await resmon.readCoverageSentence(run);

    // Same sources, from both surfaces. A denominator of 2, from the selection
    // the run saved rather than from a number chosen here.
    expect(panel.map((o) => o.source).sort()).toEqual(report.map((o) => o.source).sort());
    expect(report.length).toBe(2);
    expect(sentence).toContain(`${report.length} selected sources`);

    // And they agree on the split, not merely on the membership.
    const answeredInReport = report.filter((o) => o.label.includes('answered')).map((o) => o.source);
    const answeredInPanel = panel.filter((o) => o.note === '').map((o) => o.source);
    expect(answeredInPanel.sort()).toEqual(answeredInReport.sort());
    expect(sentence).toContain(`${answeredInReport.length} answered`);
    expect(sentence).toContain(`${report.length - answeredInReport.length} recorded non-answer`);

    // The source that could not be asked is named on both, with a reason on both.
    const keylessInReport = report.find((o) => o.source === 'springer')!;
    const keylessInPanel = panel.find((o) => o.source === 'springer')!;
    expect(keylessInReport.note.length).toBeGreaterThan(0);
    expect(keylessInPanel.note.length, 'the run panel showed no reason for the source that could not answer').toBeGreaterThan(0);
    expect(keylessInPanel.note.toLowerCase()).toContain('key');
    expect(keylessInReport.note.toLowerCase()).toContain('key');

    console.log(`[J29] panel: ${JSON.stringify(panel)}`);
    console.log(`[J29] report: ${JSON.stringify(report)}`);
    console.log(`[J29] sentence: ${sentence}`);

    await resmon.takePicture('J29-recorded-source-coverage');
    expect(resmon.refusedConnections()).toEqual([]);
  });
});
