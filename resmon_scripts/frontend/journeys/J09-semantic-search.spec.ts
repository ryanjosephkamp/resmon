/**
 * J09 Semantic search — with the vector extension present, ranking by meaning
 * appears, labels what it ranked against, shows a distance per paper and puts
 * the papers it could not rank last and counts them.
 *
 * The register has two arms and a runner can only be honest about one of them
 * at a time. The extension is a runtime dependency and loads here, so **this
 * spec exercises the present arm** and prints the absent arm as NOT VERIFIED
 * rather than faking a build that cannot load it. Where the extension does not
 * load — and there is at least one CI runner whose Python cannot — the arms
 * swap over and the spec asserts the absence instead. Either way the run says
 * which one it measured.
 *
 * **The model is authored and local.** A deterministic vector per text, served
 * on loopback, called by the backend's own embedding client over a real socket.
 * That is enough to establish that the app ranks, labels and counts what a
 * model gave it. It is not enough to establish that the ranking is *good*, and
 * this spec does not claim that.
 */
import { expect, journey } from './driver';

journey.describe('J09 Semantic search', () => {
  journey('the arm this machine can honestly exercise: controls, labels, distances and the unranked tail', async ({ resmon }) => {
    const health = await resmon.backend.health();
    const extension = health.embeddings?.extension ?? null;
    console.log(`[J09] vector extension: ${JSON.stringify(health.embeddings)}`);

    if (!extension) {
      // The absent arm. The register's rule is that the controls are gone, not
      // disabled, and that the app says why rather than leaving a person to
      // guess. The other arm cannot run on this machine and the run says so.
      expect(
        String(health.embeddings?.reason ?? ''),
        'the build cannot rank and does not say why',
      ).not.toBe('');
      const status = await resmon.backend.embeddingsStatus();
      expect(status.capability.available).toBe(false);
      expect(String(status.capability.reason ?? '').length).toBeGreaterThan(0);
      const ranked = await resmon.rankTheExplorerBy('perovskite');
      expect(ranked.controlsPresent, 'a build that cannot rank still offers the control').toBe(false);
      console.log(
        '[J09] NOT VERIFIED: the present arm. This machine cannot load the vector '
        + `extension (${health.embeddings?.reason}), so nothing could be ranked here.`,
      );
      expect(resmon.refusedConnections()).toEqual([]);
      return;
    }

    // The present arm. The model is configured before anything is collected, so
    // the papers are embedded as they are stored, which is the path a person
    // with a lane configured actually takes.
    const model = await resmon.enableRankingByMeaning();
    const run = await resmon.runDive({ source: 'arxiv', keywords: ['perovskite'], cap: 10 });
    expect((await resmon.waitForRunToSettle(run)).status).toBe('completed');

    const status = await resmon.backend.embeddingsStatus();
    console.log(`[J09] coverage: ${JSON.stringify(status.coverage)}; capability: ${JSON.stringify(status.capability)}`);
    expect(status.capability.available, `the capability is still unavailable: ${status.capability.reason}`).toBe(true);
    expect(status.coverage.embedded, 'nothing was embedded').toBeGreaterThan(0);

    const ranked = await resmon.rankTheExplorerBy('perovskite');
    console.log(`[J09] ${JSON.stringify(ranked.note)}`);
    expect(ranked.controlsPresent, 'a build that can rank offers no control').toBe(true);

    // It labels what it ranked against — both the phrase and the model — rather
    // than presenting an order with no account of where it came from.
    expect(ranked.note, 'the ranked list does not say what it ranked against').toContain('Closest to:');
    expect(ranked.note).toContain('perovskite');
    expect(ranked.note, 'the ranked list does not name the model that ranked it').toContain(model);

    // A distance per paper, as a number. "Closer" is a claim the app is
    // entitled to make only because it can show the figure behind it.
    const distances = ranked.list.rows.map((row) => row.distance).filter(Boolean);
    console.log(`[J09] distances: ${JSON.stringify(distances)}`);
    expect(distances.length, 'a ranked list showed no distances').toBeGreaterThan(0);
    expect(distances.some((distance) => /^\d+\.\d{3}$/.test(distance))).toBe(true);

    // And the tail. Where the corpus has papers the model could not reach, the
    // note carries both counts from the backend's own reckoning — which is what
    // makes "listed last" checkable rather than implied: the unranked are
    // counted, not dropped.
    const counts = /(\d+) ranked, (\d+) not embedded yet and listed last/.exec(ranked.note);
    if (counts) {
      const [, rankedCount, unranked] = counts;
      console.log(`[J09] ${rankedCount} ranked, ${unranked} not embedded and listed last.`);
      expect(Number(rankedCount), 'nothing was ranked').toBeGreaterThan(0);
      if (Number(unranked) > 0) {
        // Where there is a tail, it is at the end: every row with no distance
        // comes after every row that has one.
        const firstUnranked = ranked.list.rows.findIndex((row) => !/^\d/.test(row.distance));
        const lastRanked = ranked.list.rows.map((row) => /^\d/.test(row.distance)).lastIndexOf(true);
        expect(firstUnranked, 'an unranked paper was listed before a ranked one').toBeGreaterThan(lastRanked);
      }
    } else {
      // Every paper in this corpus was embedded as it was stored, so there is
      // no tail to count and the note does not invent one.
      const unrankedRows = ranked.list.rows.filter((row) => !/^\d/.test(row.distance));
      expect(unrankedRows, 'the note accounts for no unranked papers but the list shows some')
        .toEqual([]);
      console.log(
        '[J09] NOT VERIFIED: the unranked tail, listed last and counted. Every paper in '
        + 'this corpus was embedded as it was stored, so there was none — and the note '
        + 'carried no count rather than printing a zero.',
      );
    }

    console.log(
      '[J09] NOT VERIFIED: the absent arm. The vector extension loads on this '
      + 'machine, so the "no controls, and a reason" branch was not the one '
      + 'exercised here.',
    );

    await resmon.takePicture('J09-semantic-search');
    expect(resmon.refusedConnections()).toEqual([]);
  });
});
