/**
 * J10 Near-duplicate links — the linked pair says so on the paper's own row,
 * the corpus count does not move when the rows are folded, and both copies are
 * still there.
 *
 * The register's invariant is a refusal: resmon says two records look like the
 * same work and then leaves both of them exactly where they were. That is the
 * hard part, because the obvious implementation deletes one — and a count that
 * silently drops when a view is toggled is a corpus that cannot be reasoned
 * about.
 *
 * So the assertions are: the label is on the row, the count is the same with
 * the fold on and off, the fold says how many rows it folded and that nothing
 * was removed, and turning it off brings them back.
 *
 * The pair is authored: two records whose title and abstract are identical and
 * whose author and date are not, so insert-time dedup stores two papers and the
 * scan's two signals — a close vector and a near-identical title — both agree.
 * The vectors come from a deterministic local model, so "close" is a fact about
 * the fixture; what is being measured is what the app does with a pair, not
 * whether a real model would have found one.
 */
import { expect, journey } from './driver';

journey.use({ sourceReply: 'duplicates' });

journey.describe('J10 Near-duplicate links', () => {
  journey('the pair is labelled, the count does not move, and both copies are still there', async ({ resmon }) => {
    const health = await resmon.backend.health();
    if (!health.embeddings?.extension) {
      // The scan is a vector scan. A machine that cannot load the extension
      // cannot have this journey at all, and the app says so rather than
      // pretending: that sentence is the honest answer here.
      const status = await resmon.backend.linkStatus();
      console.log(`[J10] NOT VERIFIED: this machine cannot load the vector extension (${health.embeddings?.reason}), `
        + `so no scan could run. The app's own reason: ${JSON.stringify(status.capability?.reason)}`);
      expect(String(status.capability?.reason ?? '').length).toBeGreaterThan(0);
      expect(resmon.refusedConnections()).toEqual([]);
      return;
    }

    await resmon.enableRankingByMeaning();
    const run = await resmon.runDive({ source: 'arxiv', keywords: ['Authored'], cap: 10 });
    expect((await resmon.waitForRunToSettle(run)).status).toBe('completed');
    const corpus = await resmon.backend.corpusCounts();
    console.log(`[J10] corpus: ${JSON.stringify(corpus)}`);
    expect(corpus.documents, 'the authored pair did not both arrive').toBeGreaterThanOrEqual(2);

    const scan = await resmon.scanForNearDuplicates();
    console.log(`[J10] scan found ${scan.links} link(s): ${JSON.stringify(scan.byMethod)}`);
    expect(scan.links, 'the scan linked nothing in a corpus containing one authored pair').toBeGreaterThan(0);

    const before = await resmon.readExplorerList();
    console.log(`[J10] before collapse: ${JSON.stringify(before.countSentence)}; ${before.rows.length} rows`);
    const labelled = before.rows.filter((row) => row.alsoAppearsAs.length > 0);
    console.log(`[J10] labels: ${JSON.stringify(labelled.map((row) => row.alsoAppearsAs))}`);
    // Both halves of the pair carry it: the link is symmetric, and a person who
    // finds either copy must be told about the other.
    expect(labelled.length, 'no paper says it also appears somewhere else').toBeGreaterThanOrEqual(2);
    for (const row of labelled) {
      for (const label of row.alsoAppearsAs) {
        expect(label, `"${label}" is not an "also appears in" sentence`).toMatch(/^also appears in /);
      }
    }

    // Fold them. The count above the list is the corpus's, and it must not move.
    await resmon.collapseDuplicates(true);
    const folded = await resmon.readExplorerList();
    console.log(`[J10] after collapse: ${JSON.stringify(folded.countSentence)}; ${folded.rows.length} rows`);
    expect(folded.countSentence, 'the corpus count moved when rows were folded').toBe(before.countSentence);
    expect(folded.rows.length, 'collapsing folded nothing').toBeLessThan(before.rows.length);
    expect(folded.collapseNote, 'the folded list does not say what it folded').toMatch(/folded/);
    expect(folded.collapseNote, 'the folded list does not say nothing was removed').toMatch(/Nothing was removed/i);

    // And unfold. Both copies come straight back, by title, without a refetch
    // having been needed to find them.
    await resmon.collapseDuplicates(false);
    const restored = await resmon.readExplorerList();
    console.log(`[J10] after unfolding: ${restored.rows.length} rows`);
    expect(restored.rows.map((row) => row.title).sort(), 'a folded copy did not come back')
      .toEqual(before.rows.map((row) => row.title).sort());
    expect(restored.countSentence).toBe(before.countSentence);
    // The corpus itself never moved either, which is the claim the note makes.
    expect(await resmon.backend.corpusCounts()).toEqual(corpus);

    await resmon.takePicture('J10-near-duplicate-links');
    expect(resmon.refusedConnections()).toEqual([]);
  });
});
