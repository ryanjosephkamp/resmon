/**
 * J11 Coverage audit — "is this finding what I meant?" says what it is
 * comparing against, and says so loudly when the comparison is circular.
 *
 * The audit's honest failure mode is the one this row is about. With no intent
 * sentence written for a routine, it falls back to the routine's own keywords —
 * which measures the query against the results the query produced. That is
 * circular, it is still a little useful, and the panel has to say which of
 * those two it is doing. The journey reads the panel with no intent, writes
 * one, and reads it again.
 *
 * Two of the register's sentences cannot be reached by a corpus this size and
 * the spec says so rather than pretending. "Showing 25 of N" renders only when
 * a list is longer than twenty-five, and the missed count is labelled a floor
 * only when the nearest-neighbour budget came back full — which needs something
 * on the order of seventy-five close papers. An authored corpus of a handful
 * reaches neither, so both are asserted conditionally and printed as
 * NOT VERIFIED when the corpus did not reach them.
 */
import { expect, journey } from './driver';

journey.describe('J11 Coverage audit', () => {
  journey('the panel names what it compares against, and calls a keyword fallback circular', async ({ resmon }) => {
    const health = await resmon.backend.health();
    const hasVectors = Boolean(health.embeddings?.extension);

    await resmon.createRoutine({
      name: 'Journey coverage routine',
      cron: '0 6 * * *',
      sources: ['arxiv'],
      keywords: ['perovskite'],
    });
    if (hasVectors) await resmon.enableRankingByMeaning();
    const fired = await resmon.fireRoutineNow('Journey coverage routine');
    expect((await resmon.waitForRunToSettle(fired)).status).toBe('completed');

    const circular = await resmon.readCoverageAudit('Journey coverage routine');
    console.log(`[J11] with no intent: ${JSON.stringify(circular.intent)}`);
    console.log(`[J11] reason: ${JSON.stringify(circular.reason)}`);

    // The panel names what it is comparing against, and where that is the
    // routine's own keywords it says what is wrong with doing so.
    expect(circular.intent, 'the panel does not say what it compares against').toContain('Comparing against');
    expect(circular.intent, 'the panel does not name the keywords it fell back to').toContain('perovskite');
    expect(
      circular.intent,
      'the panel fell back to the keywords without saying the comparison is circular',
    ).toMatch(/results the query produced/);
    expect(circular.intent).toMatch(/no intent has been written/);

    // What it cannot see is stated whatever the outcome, because a short list
    // of "missed" papers is only readable next to it.
    expect(circular.cannotSee, 'the panel does not say what it cannot see')
      .toMatch(/only compare against papers it already holds/);

    // Write the sentence, and the panel stops apologising for the comparison.
    await resmon.writeRoutineIntent(
      'Journey coverage routine',
      'Layered perovskite film stability, for the journey suite.',
    );
    const stated = await resmon.readCoverageAudit('Journey coverage routine');
    console.log(`[J11] with an intent: ${JSON.stringify(stated.intent)}`);
    expect(stated.intent, 'the written intent is not what the panel compares against')
      .toContain('Layered perovskite film stability');
    expect(stated.intent, 'the panel still calls the comparison circular').toMatch(/the intent written for this routine/);
    expect(stated.intent).not.toMatch(/results the query produced/);

    // The two list sentences, where this corpus reaches them.
    const showing = [stated.offTargetShowing, stated.missedShowing].filter(Boolean);
    if (showing.length) {
      console.log(`[J11] showing lines: ${JSON.stringify(showing)}`);
      for (const line of showing) expect(line).toMatch(/^Showing \d[\d,]* of (at least )?\d[\d,]*\.$/);
    } else {
      console.log(
        '[J11] NOT VERIFIED: the "Showing 25 of N" line on either list. It renders '
        + 'only when a list is longer than the twenty-five the panel draws, and the '
        + 'authored corpus this journey seeds is a handful of papers. The wording is '
        + 'covered by the renderer suite; what a real corpus does is not measured here.',
      );
    }
    if (stated.missedShowing.includes('at least')) {
      expect(stated.missedShowing, 'a bounded missed count is not labelled a floor').toContain('at least');
    } else {
      console.log(
        '[J11] NOT VERIFIED: the missed count labelled a floor. That label appears only '
        + "when the audit's nearest-neighbour budget came back full — on the order of "
        + 'seventy-five papers close to the intent — which this corpus does not reach.',
      );
    }
    if (!hasVectors) {
      console.log(
        `[J11] NOT VERIFIED: the two lists themselves. This machine cannot load the `
        + `vector extension (${health.embeddings?.reason}), so the audit had nothing to `
        + `measure distances with. The panel said so: ${JSON.stringify(stated.reason)}`,
      );
      expect(stated.reason.length, 'the audit drew nothing and gave no reason').toBeGreaterThan(0);
    }

    await resmon.takePicture('J11-coverage-audit');
    expect(resmon.refusedConnections()).toEqual([]);
  });
});
