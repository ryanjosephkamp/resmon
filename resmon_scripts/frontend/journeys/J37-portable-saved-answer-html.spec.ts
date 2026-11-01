/**
 * J37 Portable saved-answer HTML — the file Export HTML writes is readable with
 * resmon closed and nothing reachable, every citation in it leads to its exact
 * quote and back, and an answer the app refused reads as refused there too.
 *
 * The row is about a file outliving the app, so the app is closed before the
 * file is opened, and the file is opened in a reader that is not resmon: a
 * bare window that permits one request — the file itself, once — and writes
 * down every other one, every window the document tries to open and every
 * navigation away from it. "It reads offline" is then the absence of any such
 * attempt, which is a measurement, rather than the absence of a network, which
 * would be a property of the machine the suite ran on.
 *
 * **The citations are held against the app's record, not against the file.**
 * Before the app is closed, the saved answer's own citations — source, quote
 * and codepoint range — are read over its API. Offline, each citation link is
 * followed by keyboard, as a person who does not use a mouse would follow it;
 * the quote it lands on must be that citation's quote at that range, and its
 * return link must land focus back on the citation it came from. A document
 * whose links all pointed at the first quote would satisfy a count.
 *
 * **The refused answer is the other half.** J36 shows that an answer citing
 * outside its selection is not presented as cited in the app. A file is a
 * second presentation, read by somebody who never saw the app's banner, so the
 * refused answer is exported too and must say, in the file, that it is
 * incomplete and unvalidated — with no citation links at all.
 */
import { authoredPdf, expect, journey } from './driver';

const PAPER = 'J37 paper.pdf';
const CHOSEN = 'J37 chosen.md';
const PAGES = ['J37 page one: an invented page.', 'J37 page two: the page the answer is built from.'];
const CHOSEN_TEXT = '# J37 chosen note\nAn invented observation, quoted in a file that outlives the app.\n';
const REQUEST = {
  select: [{ file: PAPER, page: 2 }, { file: CHOSEN }],
  format: 'briefing' as const,
  instruction: 'Summarize the selected excerpts.',
  model: 'authored-selected-model',
};

journey.describe('J37 Portable saved-answer HTML', () => {
  journey('the exported answer reads with resmon closed, and every citation leads to its exact quote and back', async ({ resmon }) => {
    await resmon.chooseAParentFolderForTheLibrary();
    await resmon.createTheManagedVault();
    expect(await resmon.importIntoTheLibrary([
      { name: PAPER, content: authoredPdf(PAGES) },
      { name: CHOSEN, content: CHOSEN_TEXT },
    ])).toContain('2 retained');
    await resmon.startAnEvidenceProjectFrom(PAPER, 'J37 project');
    await resmon.addToTheEvidenceProject([CHOSEN]);
    await resmon.useAnAuthoredModelForSelectedAnswers();

    // A validated answer, and the app's own record of its citations.
    const cited = (await resmon.askFromSelectedEvidence(REQUEST)).answer;
    expect(cited.state).toBe('succeeded');
    const record = await resmon.backend.selectedAnswer('J37 project', cited.id);
    expect(record.result, 'the app stored no structured result for an answer it shows as cited').not.toBeNull();
    const saved = record.result!.sections.flatMap((section) => section.items.flatMap((item) => item.citations));
    console.log(`[J37] the saved answer cites: ${JSON.stringify(saved)}`);
    expect(saved.length, 'the answer cites nothing, so this row would prove nothing').toBeGreaterThan(0);
    const citedFile = await resmon.exportTheOpenAnswerAsHtml();

    // A refused answer, exported the same way.
    resmon.theAuthoredModelCitesTextItWasNotSent('J37 a sentence that no selected source contains.');
    const refused = (await resmon.askFromSelectedEvidence(REQUEST)).answer;
    expect(refused.state).toBe('failed');
    const refusedFile = await resmon.exportTheOpenAnswerAsHtml();
    await resmon.takePicture('J37-portable-saved-answer-html');

    for (const file of [citedFile, refusedFile]) {
      expect(file.path.endsWith('.html'), `${file.path} is not an HTML file`).toBe(true);
      expect(file.text.startsWith('<!doctype html>'), `${file.path} is not a document`).toBe(true);
    }

    // — resmon closed; somebody else's reader -------------------------------------
    await resmon.closeTheApp();
    const offline = await resmon.readTheFileOffline(citedFile);
    console.log(`[J37] offline: refused ${JSON.stringify(offline.refused)}, escapes `
      + `${JSON.stringify(offline.escapes)}, ${offline.activeElements} active element(s), `
      + `${offline.citations.length} citation(s): ${JSON.stringify(offline.citations)}`);
    expect(offline.refused, 'the document reached for something beyond itself').toEqual([]);
    expect(offline.escapes, 'the document tried to open or navigate somewhere else').toEqual([]);
    expect(offline.activeElements, 'the document carries an element that can run or fetch').toBe(0);
    for (const href of offline.hrefs) {
      expect(href, 'the document links somewhere other than inside itself').toMatch(/^#[a-z0-9-]+$/);
    }
    expect(offline.text, 'the file does not identify the answer it was exported from').toContain(cited.id);
    expect(offline.saysUnvalidated, 'a validated answer reads as unvalidated offline').toBe(false);

    // Every citation the app saved, and no other, followed there and back.
    expect(offline.citations.map((c) => `${c.quote}|${c.start}|${c.end}`).sort(),
      'the file\'s citations are not the saved answer\'s citations')
      .toEqual(saved.map((c) => `${c.quote}|${c.start_codepoint}|${c.end_codepoint}`).sort());
    for (const citation of offline.citations) {
      expect(citation.href, `${citation.reference} points outside the document's own sources`)
        .toMatch(/^#source-\d+-citation-/);
      expect(citation.arrivedAt, `${citation.reference} did not lead to its quote`).toBe(citation.href);
      expect(citation.returnedTo, `${citation.reference}'s quote does not lead back to it`)
        .toBe(`#${citation.reference}`);
      expect(citation.returnFocused, `returning from ${citation.reference} did not put focus back on it`)
        .toBe(true);
    }
    // And each quote is what its source's frozen excerpt says at that range,
    // inside the file — the check a reader without resmon can make for
    // themselves, and the one a file whose quotes floated free of their
    // excerpts would fail.
    for (const citation of offline.citations) {
      const at = Array.from(citation.excerpt)
        .slice(citation.start - citation.excerptStart, citation.end - citation.excerptStart).join('');
      expect(at, `${citation.reference}'s quote is not its excerpt's text at its range`).toBe(citation.quote);
    }

    const offlineRefused = await resmon.readTheFileOffline(refusedFile);
    console.log(`[J37] offline, the refused answer: unvalidated=${offlineRefused.saysUnvalidated}, `
      + `${offlineRefused.citations.length} citation(s), refused ${JSON.stringify(offlineRefused.refused)}`);
    expect(offlineRefused.refused).toEqual([]);
    expect(offlineRefused.saysUnvalidated, 'a refused answer does not say so in the file').toBe(true);
    expect(offlineRefused.citations, 'a refused answer offers citations in the file').toEqual([]);
    expect(offlineRefused.text).toContain(refused.id);
    expect(offlineRefused.text).toContain('failed');

    console.log('[J37] NOT VERIFIED: a browser. The reader is a bare Chromium window with every '
      + 'request but the file refused; other engines, a phone and a person\'s own browser '
      + 'settings are not observed.');
    console.log('[J37] NOT VERIFIED: the save dialog. The download destination is answered by the '
      + 'driver; the request, the bytes and the app\'s download record are the app\'s.');
    console.log('[J37] NOT VERIFIED: printing, zoom and narrow widths — `e2e/atlas-answers.spec.ts` '
      + 'covers those; this row is the file outliving the app.');

    expect(resmon.refusedConnections()).toEqual([]);
  });
});
