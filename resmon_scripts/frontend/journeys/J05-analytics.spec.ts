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
import type { Figure } from './driver';

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
    //
    // Compared without case: the stylesheet upper-cases these headings, so what
    // a person reads — and what `innerText` returns — is "YOUR CORPUS". Pinning
    // the capitalisation would be pinning a stylesheet rule.
    const drawn = view.headings.map((heading) => heading.toLowerCase());
    for (const card of [
      'Your corpus',
      'Which sources earn their place',
      'Which keywords earn their place',
      'How quickly each source surfaces a paper',
      'Routine health',
    ]) {
      expect(drawn, `the Analytics page no longer draws "${card}"`).toContain(card.toLowerCase());
    }

    // The counts the seeded corpus implies. The Papers tile is the Explorer's
    // own total, read from the backend, not a number chosen here.
    const tile = (label: string): Figure | undefined => view.tiles
      .find((candidate) => candidate.label.toLowerCase() === label.toLowerCase());
    const papers = tile('Papers');
    expect(papers, 'the corpus card draws no paper count').toBeTruthy();
    expect(Number(papers!.value.replace(/[^0-9]/g, '')), 'the paper tile disagrees with the corpus')
      .toBe(corpus.documents);
    const sources = tile('Sources used');
    expect(Number(sources!.value.replace(/[^0-9]/g, '')), 'one source answered, and the tile says otherwise').toBe(1);
    // One source cannot be compared with another, and the page says so rather
    // than drawing a bar chart of one.
    console.log(`[J05] not enough yet: ${JSON.stringify(view.notEnoughYet)}`);

    // The expensive view waits to be asked, and says so where a person can read
    // it. This is the property: reading every paper in the corpus is not
    // something a page does on arrival.
    const page = await resmon.readWhatThisPlaceSays();
    expect(page, 'the keyword view no longer says why it does not run on its own')
      .toMatch(/not run automatically/i);

    const keywords = await resmon.measureKeywordYield();
    console.log(`[J05] keyword yield: ${JSON.stringify(keywords)}`);
    expect(
      keywords.bars.length > 0 || keywords.notEnoughYet.length > 0,
      'the keyword view drew neither a yield nor a reason for not drawing one',
    ).toBe(true);
    if (keywords.bars.length) {
      expect(keywords.bars.map((row) => row.label), 'the keyword the run used is not in its own yield')
        .toContain('perovskite');
    } else {
      // Two authored papers is below the sample the share needs, and the card
      // says so rather than drawing a percentage of two.
      console.log(
        '[J05] NOT VERIFIED: a per-keyword yield. The authored corpus is smaller than '
        + `the sample a share needs, and the card said so instead: ${JSON.stringify(keywords.notEnoughYet)}`,
      );
      expect(keywords.notEnoughYet).toMatch(/not enough|needs at least|so far/i);
    }

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
