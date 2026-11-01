/**
 * J36 Selected-evidence answers — what leaves the app is exactly what the
 * person selected and was shown before Send, and an answer is shown as cited
 * only when every citation is an exact quote of that selection.
 *
 * Two halves, and the second is the one that makes the first worth anything.
 *
 * *What leaves.* The preview is the app's promise about what Send will
 * disclose; the authored model on loopback is the only place that can say
 * what was actually sent. So the two are compared, and the request is searched
 * for the things that were not selected — a page of the PDF that was left out,
 * a whole file, a note on a selected file whose body was not ticked. Each has a
 * marker of its own, so an absence is an absence of something specific.
 *
 * *What is shown as cited.* A model that only ever quoted what it was sent
 * would make "cites only the selected evidence" true by construction, and a
 * journey that asserted it would be measuring the double. So the double is
 * then told to attribute to a selected source a sentence that is not in it —
 * the sentence from the file that was left out, which is what a careless model
 * reaching past its brief would produce. The contract says an invalid citation
 * produces failed, unvalidated output; this row holds the app to that on
 * screen and in its record, and checks that the model was in fact asked, so a
 * refusal is the app's decision rather than an absent call.
 *
 * **What this row does not establish**, printed at the end.
 */
import { authoredPdf, expect, journey } from './driver';

const PAPER = 'J36 paper.pdf';
const CHOSEN = 'J36 chosen.md';
const LEFT_OUT = 'J36 left out.txt';

const PAGES = [
  'J36-UNSELECTED-PAGE: page one of an invented paper, never selected.',
  'J36 page two: the selected page of an invented paper.',
];
const CHOSEN_TEXT = '# J36 chosen note\nAn invented observation the answer may cite.\n';
const LEFT_OUT_SENTENCE = 'J36-UNSELECTED-FILE claims something no selected source says.';
const TICKED_NOTE = 'J36 OWNER NOTE ticked for the answer.';
const UNTICKED_NOTE = 'J36-UNSELECTED-NOTE on a selected file, not ticked.';

/** Every marker of something that was not selected. None may reach the model. */
const NOT_SELECTED = ['J36-UNSELECTED-PAGE', 'J36-UNSELECTED-FILE', 'J36-UNSELECTED-NOTE', LEFT_OUT];

const REQUEST = {
  select: [{ file: PAPER, page: 2 }, { file: CHOSEN }],
  includeNotes: [TICKED_NOTE],
  format: 'question' as const,
  instruction: 'What do the selected excerpts say?',
  model: 'authored-selected-model',
};

journey.describe('J36 Selected-evidence answers', () => {
  journey('only the selection leaves the app, and an answer citing anything else is not shown as cited', async ({ resmon }) => {
    await resmon.chooseAParentFolderForTheLibrary();
    await resmon.createTheManagedVault();
    expect(await resmon.importIntoTheLibrary([
      { name: PAPER, content: authoredPdf(PAGES) },
      { name: CHOSEN, content: CHOSEN_TEXT },
      { name: LEFT_OUT, content: `${LEFT_OUT_SENTENCE}\n` },
    ])).toContain('3 retained');
    await resmon.startAnEvidenceProjectFrom(CHOSEN, 'J36 project');
    await resmon.addToTheEvidenceProject([PAPER, LEFT_OUT]);
    await resmon.saveAnEvidenceNote({ file: CHOSEN, body: TICKED_NOTE });
    await resmon.saveAnEvidenceNote({ file: CHOSEN, body: UNTICKED_NOTE });
    await resmon.useAnAuthoredModelForSelectedAnswers();

    // — what the person is shown, and what the model is then sent ---------------
    const first = await resmon.askFromSelectedEvidence(REQUEST);
    console.log(`[J36] preview sources: ${JSON.stringify(first.preview.sources)}`);
    console.log(`[J36] preview notes: ${JSON.stringify(first.preview.notes)}`);
    // Sorted: the app numbers the sources S01, S02… in an order of its own,
    // which has come out both ways round for the same two selections.
    expect(first.preview.sources.map((s) => `${s.file}|${s.page}|${s.text}`).sort(), 'the preview is not the selection')
      .toEqual([`${PAPER}|2|${PAGES[1]}`, `${CHOSEN}|1|${CHOSEN_TEXT}`].sort());
    expect(first.preview.notes).toEqual([TICKED_NOTE]);

    const received = resmon.readWhatTheAuthoredModelReceived();
    expect(received, 'one Send made more or fewer than one request of the model').toHaveLength(1);
    const sent = received[0].userPayload!.payload;
    expect(sent.sources.map((s) => `${s.source_id}|${s.text}`), 'the model was sent something other than the preview')
      .toEqual(first.preview.sources.map((s) => `${s.id}|${s.text}`));
    expect(sent.notes.map((n) => n.body)).toEqual([TICKED_NOTE]);
    for (const marker of NOT_SELECTED) {
      expect(received[0].raw, `"${marker}" was not selected and reached the model`).not.toContain(marker);
    }

    // — the answer, and each citation in it ---------------------------------------
    console.log(`[J36] the answer: ${JSON.stringify({ ...first.answer, text: undefined })}`);
    expect(first.answer.state).toBe('succeeded');
    expect(first.answer.unvalidated, 'a validated answer is shown as unvalidated').toBeNull();
    const shownIds = first.answer.items.flatMap((item) => item.citations.map((label) => label.split(' · ')[0]));
    expect(shownIds.length, 'the answer cites nothing, so this row would prove nothing').toBeGreaterThan(0);
    for (const id of shownIds) {
      expect(first.preview.sources.map((s) => s.id), `the answer cites ${id}, which was not selected`).toContain(id);
    }
    // The app's record, held against the selection rather than against itself:
    // every saved quote is the selected text at exactly its codepoint range.
    const saved = await resmon.backend.selectedAnswer('J36 project', first.answer.id);
    expect(saved.result, 'the app stored no structured result for an answer it shows as cited').not.toBeNull();
    const citations = saved.result!.sections.flatMap((section) => section.items.flatMap((item) => item.citations));
    const sources = saved.request.payload.sources;
    for (const citation of citations) {
      const source = sources.find((s) => s.source_id === citation.source_id);
      expect(source, `a saved citation names ${citation.source_id}, which was not selected`).toBeTruthy();
      const at = Array.from(source!.text)
        .slice(citation.start_codepoint - source!.start_codepoint, citation.end_codepoint - source!.start_codepoint)
        .join('');
      expect(at, `${citation.source_id}'s saved quote is not the selected text at its range`).toBe(citation.quote);
    }
    const opened = await resmon.openEachCitationOfTheAnswer();
    console.log(`[J36] citations opened: ${JSON.stringify(opened)}`);
    expect(opened).toHaveLength(citations.length);
    for (const citation of opened) {
      expect(citation.resolution).toMatch(/^Citation matched this exact current text range\./);
      expect(citation.highlighted, `${citation.label} highlights something other than its quote`).toBe(citation.frozen);
    }

    // — a model that cites what it was not sent -----------------------------------
    resmon.theAuthoredModelCitesTextItWasNotSent(LEFT_OUT_SENTENCE);
    const second = await resmon.askFromSelectedEvidence(REQUEST);
    console.log(`[J36] the answer that cited outside the selection: ${JSON.stringify({ ...second.answer, text: undefined })}`);
    expect(resmon.readWhatTheAuthoredModelReceived(), 'the model was not asked, so the refusal proves nothing')
      .toHaveLength(2);
    expect(second.answer.state, 'an answer citing text outside the selection was accepted').toBe('failed');
    expect(second.answer.items, 'an answer citing outside the selection is shown with its citations').toEqual([]);
    expect(second.answer.unvalidated, 'the refused answer is not labelled unvalidated').not.toBeNull();
    expect((await resmon.backend.selectedAnswer('J36 project', second.answer.id)).result,
      'the app stored a structured result for an answer it should have refused').toBeNull();

    // — the saved answer, reopened, calls nothing ---------------------------------
    await resmon.reopenTheApp();
    await resmon.openTheEvidenceProject('J36 project');
    const again = await resmon.openTheSavedAnswer(first.answer.id);
    expect(again.items, 'the saved answer came back with different citations').toEqual(first.answer.items);
    expect(resmon.readWhatTheAuthoredModelReceived(), 'opening a saved answer asked the model again')
      .toHaveLength(2);

    console.log('[J36] NOT VERIFIED: any real model. The answer comes from an authored model on '
      + 'loopback; the request, the key read out of the app\'s own credential store, the validation '
      + 'and the saved answer are the app\'s. Whether a live model cites well is not observed.');
    console.log('[J36] NOT VERIFIED: the Claude Code connection. Its CLI path points at nothing on '
      + 'purpose, so no agent CLI can start; the CLI lane of this feature is `e2e/atlas-answers.spec.ts`\'s.');
    console.log('[J36] NOT VERIFIED: that a citation supports the claim it is attached to. The app '
      + 'checks text identity only and says so; so does this row.');

    await resmon.takePicture('J36-selected-evidence-answers');
    expect(resmon.refusedConnections()).toEqual([]);
  });
});
