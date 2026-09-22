/**
 * J28 Reading queue — saving a paper to read later, reading it, and taking one
 * out again, without any of that touching the corpus.
 *
 * The register's invariant is a single sentence and it is the one worth the
 * whole row: **membership removal never deletes a paper.** A queue that quietly
 * deleted what you took out of it would destroy a person's own retrieved
 * literature on a click labelled "Remove", and B4 says only the Danger Zone the
 * user operates deletes from a corpus. So the last thing this journey does is
 * go and look at the Explorer for the paper it just removed.
 *
 * The papers are real: a dive against the authored source, stored by the
 * shipped arXiv client, and the ids the queue carries are the document ids the
 * local API uses. Both records are saved from the run's own Papers tab with
 * real clicks — the save path is the journey, unlike the seeded creations
 * elsewhere in this suite, and the badge each row grows afterwards is rendered
 * from `queue_status` as the backend returned it rather than from what was
 * clicked.
 */
import { expect, journey } from './driver';

journey.describe('J28 Reading queue', () => {
  journey('two papers saved, one read, one removed — and the removed one is still in the corpus', async ({ resmon }) => {
    const run = await resmon.runDive({ source: 'arxiv', keywords: ['perovskite'], days: 30, cap: 20 });
    expect((await resmon.waitForRunToSettle(run)).status).toBe('completed');

    const corpusBefore = (await resmon.backend.corpusCounts()).documents;
    expect(corpusBefore, 'the dive stored nothing to read').toBeGreaterThan(1);

    // Saved from the run, by the button a person presses.
    const saved = await resmon.savePapersFromRun(run);
    expect(saved.length, 'the run offered a different number of papers than the corpus holds')
      .toBe(corpusBefore);
    const [first, second] = saved;

    // Both are in the queue, both to read. Read off the page rather than
    // assumed from the clicks: the page re-reads the queue from the backend.
    const toRead = await resmon.readReadingQueue('to read');
    expect(toRead.map((p) => p.id).sort(), 'the queue does not hold what was saved to it')
      .toEqual(saved.map((p) => p.id).sort());
    expect(toRead.every((p) => p.state === 'To read')).toBe(true);

    // One marked Read. The `To read` filter is a claim about state, so the
    // paper leaving that list is the assertion — a badge that changed while the
    // filter went on listing it would be a screen disagreeing with itself.
    await resmon.markPaperRead(first);
    expect(
      (await resmon.readReadingQueue('to read')).map((p) => p.id),
      'a paper marked Read is still listed under To read',
    ).toEqual([second.id]);
    const read = await resmon.readReadingQueue('read');
    expect(read.map((p) => p.id)).toEqual([first.id]);
    expect(read[0].state).toBe('Read');

    // One removed. Out of the queue entirely, under every filter.
    await resmon.removeFromReadingQueue(second);
    const remaining = await resmon.readReadingQueue('all');
    expect(remaining.map((p) => p.id), 'Remove left the paper in the queue').toEqual([first.id]);

    // The invariant. The paper that left the queue is still a paper: the
    // Explorer lists it by title, and the corpus count has not moved.
    const titles = await resmon.readExplorerTitles();
    expect(
      titles,
      'the paper removed from the reading queue was deleted from the corpus (B4)',
    ).toContain(second.title);
    expect(titles).toContain(first.title);
    expect(
      (await resmon.backend.corpusCounts()).documents,
      'removing a queue membership changed the corpus count',
    ).toBe(corpusBefore);

    // The export is the selection, and the selection is what is left. RIS
    // because the register's walk names it; the count is the assertion, so a
    // serializer that emitted both papers would fail even though both are in
    // the corpus.
    const ris = await resmon.exportReadingQueue([first], 'ris');
    expect(ris.match(/^TY {2}- /gm) ?? [], 'the RIS export is not one record').toHaveLength(1);
    expect(ris, 'the RIS export does not name the paper that is still in the queue')
      .toContain(first.title);
    expect(ris, 'the RIS export names the paper that was removed from the queue')
      .not.toContain(second.title);

    console.log(
      `[J28] ${saved.length} of ${corpusBefore} stored papers saved; 1 read, 1 removed; `
      + `${titles.length} papers still in the Explorer; RIS export: 1 record.`,
    );
    console.log(
      '[J28] NOT VERIFIED: paging past the default 50 and the selection-clearing rule. '
      + 'The authored source answers with two records, so this row says nothing about a '
      + 'queue larger than one page; e2e/reading-queue.spec.ts drives 51.',
    );

    await resmon.takePicture('J28-reading-queue');
    expect(resmon.refusedConnections()).toEqual([]);
  });
});
