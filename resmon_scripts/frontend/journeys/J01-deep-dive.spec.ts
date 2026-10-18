/**
 * J01 Deep Dive — a source that failed is reported as a failure, never as an
 * empty field.
 *
 * The register's invariant is about the difference between "nobody answered"
 * and "nothing was found", and the only way to see it is to make a source
 * really fail. The authored source this journey runs against accepts the
 * connection and ends it without an HTTP response, so the shipped arXiv client
 * and `safe_request` record a transport failure the way they would against a
 * provider that dropped the call. Nothing about the outcome is handed to the
 * renderer: every word below was computed by the app from what actually
 * happened on that socket.
 */
import { expect, journey } from './driver';

journey.use({ sourceReply: 'dead' });

journey.describe('J01 Deep Dive', () => {
  journey('a source that did not answer is named, with its reason, and nothing is invented', async ({ resmon }) => {
    const run = await resmon.runDive({
      source: 'arxiv',
      keywords: ['perovskite', 'stability'],
      days: 30,
      cap: 20,
    });

    await resmon.waitForRunToSettle(run);

    // The run's *status* is deliberately not asserted here, and re-adding it
    // would break this suite rather than strengthen it.
    //
    // This file runs against two builds from one commit — this checkout's app
    // and the `classic` branch's — so every assertion in it has to be true of
    // both. The status is exactly where the two now differ: a one-source dive
    // whose source does not answer records `failed` on this build and
    // `completed` on classic, and the classic branch is frozen, so no
    // expectation can be true of both. An earlier revision of this PR asserted
    // `failed` here and turned the classic leg red for that reason alone.
    //
    // The status is asserted in the two places that are about one build, and
    // both are green: `verification_scripts/test_sweep_final_status.py` (six
    // hermetic cases over a real schema-21 database, including every selected
    // source answering 503) and `e2e/coverage-reports.spec.ts` (the real
    // Electron app, for both the 503 and the unreadable-200 modes).
    //
    // Nothing is missing from the row. J01's invariant is that a source that
    // failed is *reported as a failure, never as an empty field* — a claim
    // about the per-source record, not about the run's status — and that is
    // what the rest of this test checks: the recorded `zero_reason`, the
    // denominator taken from the build's own `ZERO_REASONS`, and the report
    // naming the source with a reason cell that is not blank.

    // What the app recorded, over its own API.
    const record = await resmon.backend.searchRecord(run);
    const recorded = (record.sources ?? []).find((s: any) => s.source === 'arxiv');
    expect(recorded, 'the run recorded no outcome at all for the source it queried').toBeTruthy();

    // The denominator comes from the build under test's own vocabulary, not
    // from a list written here: the register says "one of the nine" and the
    // module at this base declares ten.
    const vocabulary = await resmon.backend.zeroReasonVocabulary();
    expect(vocabulary.length).toBeGreaterThan(0);
    expect(vocabulary, 'the recorded reason is not one the build knows').toContain(recorded.zero_reason);
    expect(recorded.zero_reason).toBe('upstream_failure');
    console.log(`[J01] 1 of ${vocabulary.length} zero reasons exercised here; `
      + `${vocabulary.length} from the build's own ZERO_REASONS.`);

    // What the person sees. The report names the source and says why, and the
    // "reason" cell is never blank — an empty cell here is the whole defect
    // this row exists to keep out.
    const outcomes = await resmon.readReportOutcomes(run);
    const shown = outcomes.find((o) => o.source === 'arxiv');
    expect(shown, 'the report does not name the source the run queried').toBeTruthy();
    expect(shown!.note.length, 'the report left the reason blank').toBeGreaterThan(0);
    expect(shown!.note).toContain('did not answer');
    expect(shown!.label).toContain('non answer');

    const sentence = await resmon.readCoverageSentence(run);
    expect(sentence).toContain('1 recorded non-answer');
    expect(sentence).toContain('0 answered');

    // And nothing was fabricated: a run whose only source never replied has no
    // papers in it.
    const counts = await resmon.backend.corpusCounts();
    expect(counts.documents, 'a failed source produced documents').toBe(0);

    await resmon.takePicture('J01-deep-dive-source-did-not-answer');
    expect(resmon.refusedConnections(), 'this journey reached off the machine').toEqual([]);
  });
});
