/**
 * J45 Source wall: what every source did on recent runs — a source that did
 * not answer never looks the same as one that answered with nothing.
 *
 * That sentence is the screen's whole claim. A literature monitor fails
 * silently: a dead source and a quiet field both produce an empty inbox, and
 * until the wall existed the difference was visible only to somebody who
 * opened several runs and compared them by hand. So this row makes both
 * happen to the same source, one run apart — the authored arXiv answers with
 * an empty feed, then goes down — and holds the wall to drawing them as two
 * different things in every channel a person reads: the state, the mark, the
 * word, the sentence behind the cell, and the verdict at the top.
 *
 * A second source is in the second run only, and it has no key. That puts the
 * wall's two other easily-confused marks on screen beside the first two: a
 * run the person did not put the source in, and a run that could not ask it.
 * "Not asked" and "could not be asked" are a choice and a gap, and the wall
 * exists to keep them apart as much as it exists to keep a failure and a zero
 * apart.
 *
 * **The words are the backend's, so the screen is held to the record.** The
 * wall composes nothing itself — every label, sentence and headline arrives on
 * `GET /api/coverage/source-wall` — so the first assertion is that what the
 * page draws is cell for cell what it was served, and the rest are about what
 * that says. A renderer that re-derived a state would fail the first; a
 * backend that collapsed two states would fail the rest.
 */
import { expect, journey } from './driver';

// The authored source answers with a valid, empty feed until it is taken down.
journey.use({ sourceReply: 'empty' });

journey.describe('J45 Source wall: what every source did on recent runs', () => {
  journey('a source that did not answer never looks the same as one that answered with nothing', async ({ resmon }) => {
    const routes = await resmon.backend.routeInventory();
    expect(routes, 'this build serves no Source wall').toContain('/api/coverage/source-wall');

    const quiet = await resmon.runDive({ source: 'arxiv', keywords: ['perovskite'] });
    console.log(`[J45] the quiet run settled ${JSON.stringify(await resmon.waitForRunToSettle(quiet))}`);
    resmon.theSourceGoesDown();
    const broken = await resmon.runSweep({ sources: ['arxiv', 'springer'], query: 'perovskite' });
    console.log(`[J45] the broken run settled ${JSON.stringify(await resmon.waitForRunToSettle(broken))}`);

    const catalog = await resmon.backend.sourceCatalog();
    const nameOf = (slug: string): string => String(catalog.find((entry) => entry.slug === slug)?.name ?? slug);

    const wall = await resmon.readTheSourceWall();
    const served = await resmon.backend.sourceWall();
    console.log(`[J45] verdict: ${JSON.stringify(wall.verdict)}; ${wall.window}`);
    console.log(`[J45] rows: ${JSON.stringify(wall.rows)}`);

    // — the screen draws what the app recorded, cell for cell -------------------
    expect(served.runs.map((run) => run.execution_id),
      'the wall\'s columns are not these two runs, oldest first').toEqual([quiet.id, broken.id]);
    expect(wall.rows.map((row) => row.source)).toEqual(
      served.sources.map((source) => source.name));
    wall.rows.forEach((row, index) => {
      const cells = served.sources[index].cells;
      expect(row.cells.map((cell) => `${cell.state}|${cell.label}`), `${row.source} is drawn differently from its record`)
        .toEqual(cells.map((cell) => `${cell.state}|${cell.label}`));
    });
    expect(wall.window).toBe('Showing 2 of 2 recorded runs');

    // — the claim: a failure and a zero are two different things ----------------
    const arxiv = wall.rows.find((row) => row.source === nameOf('arxiv'));
    expect(arxiv, 'the wall has no row for the source both runs asked').toBeTruthy();
    const [zero, failure] = arxiv!.cells;
    expect(zero.state, 'an empty answer is not drawn as an empty answer').toBe('answered_empty');
    expect(failure.state, 'a source that did not answer is not drawn as a failure').toBe('failed');
    expect(failure.glyph, 'a failure and an empty answer share a mark').not.toBe(zero.glyph);
    expect(failure.label, 'a failure and an empty answer share a word').not.toBe(zero.label);
    expect(failure.label, 'the failure is announced as some kind of answer').not.toMatch(/^answered/);

    const zeroReading = await resmon.readTheSourceWallCell(nameOf('arxiv'), 0);
    const failureReading = await resmon.readTheSourceWallCell(nameOf('arxiv'), 1);
    console.log(`[J45] the quiet cell reads ${JSON.stringify(zeroReading)}`);
    console.log(`[J45] the broken cell reads ${JSON.stringify(failureReading)}`);
    expect(failureReading.label).toBe(failure.label);
    expect(zeroReading.label).toBe(zero.label);
    expect(failureReading.note, 'the two cells say the same sentence about what happened')
      .not.toBe(zeroReading.note);

    // — and the two silences are two marks as well ------------------------------
    const springer = wall.rows.find((row) => row.source === nameOf('springer'));
    expect(springer, 'the wall has no row for the source the second run added').toBeTruthy();
    const [notAsked, couldNot] = springer!.cells;
    expect(notAsked.state, 'a source left out of a run is not drawn as not asked').toBe('not_selected');
    expect(couldNot.state, 'a source with no key is not drawn as could not be asked').toBe('could_not_be_asked');
    const marks = [zero, failure, notAsked, couldNot].map((cell) => cell.glyph);
    expect(new Set(marks).size, `four different states share a mark: ${JSON.stringify(marks)}`).toBe(4);
    // The whole key, not only the four on screen: every state has a mark of
    // its own, and the denominator is the vocabulary the app served.
    expect(wall.legend.map((entry) => entry.label)).toEqual(
      served.state_legend.map((entry) => entry.label));
    expect(new Set(wall.legend.map((entry) => entry.glyph)).size, 'two states in the key share a mark')
      .toBe(wall.legend.length);

    // — the sentence read first --------------------------------------------------
    expect(wall.verdict.level, 'a source that stopped answering does not ask for attention').toBe('attention');
    expect(wall.verdict.headline, 'the verdict does not name the source that stopped answering')
      .toContain(nameOf('arxiv'));
    expect(wall.verdict.headline).toMatch(/stopped answering/);

    console.log('[J45] NOT VERIFIED: color. The marks, fills and words are read; the hue a cell '
      + 'is drawn in, and whether two marks are told apart by eye on a real display, are not.');
    console.log('[J45] NOT VERIFIED: a real outage. The failure is an authored arXiv that drops the '
      + 'connection; what a real upstream does when it fails is the live suite\'s.');

    await resmon.takePicture('J45-source-wall');
    expect(resmon.refusedConnections()).toEqual([]);
  });
});
