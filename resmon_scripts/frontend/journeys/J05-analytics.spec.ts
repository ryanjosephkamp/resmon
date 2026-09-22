/**
 * J05 Analytics — the views draw the corpus that is actually there, the
 * expensive one only runs when asked, and the chart hands off into a
 * pre-filtered Explorer.
 *
 * Analytics is the page most able to invent a number, so the assertions are
 * about the relationship between what it draws and what the corpus holds
 * rather than about any figure in particular. The seed is one dive against the
 * authored source, so the paper count is a number this journey knows.
 *
 * The middle assertion is the one worth stating out loud. The keyword view
 * reads every paper in the corpus once, so it is deliberately *not* part of the
 * page's own load — and a version that quietly started running it on mount
 * would be slower for everybody and would still pass a test that only looked at
 * the result.
 */
import { expect, journey } from './driver';

journey.describe('J05 Analytics', () => {
  journey('the views draw the seeded corpus, the keyword view waits to be asked, and the chart leads into the Explorer', async ({ resmon }) => {
    const run = await resmon.runDive({ source: 'arxiv', keywords: ['perovskite'], cap: 10 });
    expect((await resmon.waitForRunToSettle(run)).status).toBe('completed');
    const corpus = await resmon.backend.corpusCounts();
    console.log(`[J05] corpus: ${JSON.stringify(corpus)}`);
    expect(corpus.documents).toBeGreaterThan(0);

    const view = await resmon.readAnalytics();
    console.log(`[J05] cards: ${JSON.stringify(view.headings)}`);
    console.log(`[J05] tiles: ${JSON.stringify(view.tiles)}`);

    // The five views the page stacks. The denominator is the page's own list of
    // cards, and this asserts the register's five are among them rather than
    // pinning a total that a sixth card would break for no reason.
    for (const card of [
      'Your corpus',
      'Which sources earn their place',
      'Which keywords earn their place',
      'How quickly each source surfaces a paper',
      'Routine health',
    ]) {
      expect(view.headings, `the Analytics page no longer draws "${card}"`).toContain(card);
    }

    // The counts the seeded corpus implies. The Papers tile is the Explorer's
    // own total, read from the backend, not a number chosen here.
    const papers = view.tiles.find((tile) => tile.label === 'Papers');
    expect(papers, 'the corpus card draws no paper count').toBeTruthy();
    expect(Number(papers!.value.replace(/[^0-9]/g, '')), 'the paper tile disagrees with the corpus')
      .toBe(corpus.documents);
    const sources = view.tiles.find((tile) => tile.label === 'Sources used');
    expect(Number(sources!.value.replace(/[^0-9]/g, '')), 'one source answered, and the tile says otherwise').toBe(1);
    // One source cannot be compared with another, and the page says so rather
    // than drawing a bar chart of one.
    console.log(`[J05] not enough yet: ${JSON.stringify(view.notEnoughYet)}`);

    // The expensive view waits to be asked.
    const keywords = await resmon.measureKeywordYield();
    console.log(`[J05] keyword yield: ${JSON.stringify(keywords)}`);
    expect(keywords.length, 'the keyword view drew nothing when asked').toBeGreaterThan(0);
    expect(keywords.map((row) => row.label), 'the keyword the run used is not in its own yield')
      .toContain('perovskite');

    // And the handoff. Wherever the chart offers it, following it must land in
    // the Explorer already filtered, not on the unfiltered list.
    const followed = await resmon.followTheChartIntoTheExplorer();
    console.log(`[J05] followed into ${followed.hash}`);
    expect(followed.hash, 'the link out of Analytics did not carry a filter').toMatch(/#\/explorer\?(source|category)=/);
    expect(followed.list.rows.length, 'the pre-filtered Explorer listed nothing').toBeGreaterThan(0);
    expect(followed.list.countSentence).toMatch(/matching your filters/);

    await resmon.takePicture('J05-analytics');
    expect(resmon.refusedConnections()).toEqual([]);
  });
});
