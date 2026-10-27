/**
 * J35 Evidence workspace — a passage kept from a file is pinned to the exact
 * version, page and characters it was taken from; it reopens on exactly that
 * text after the window has closed; and an export of chosen files carries
 * their records and nothing from a file that was left out.
 *
 * The row's word is *exact*, and the contract says what that means in a way a
 * journey can measure: a passage records global Unicode codepoint offsets,
 * never UTF-16 indices. Those two numbers only differ when something outside
 * the Basic Multilingual Plane comes before the quote, so the note below puts
 * two emoji in front of it on purpose — on a page of plain ASCII, an app that
 * counted UTF-16 units would pass every check here. The expected offsets are
 * computed in this file from the text it authored; they are not read back from
 * the app and compared with themselves.
 *
 * **Three readers, one page each.** The PDF's page 1 is read and page 2 is
 * not, and the reader is held to saying so: text extraction that looked at one
 * page and implied it had looked at the document is the overclaim this row
 * exists to catch.
 *
 * **What this row does not establish**, printed at the end.
 */
import { authoredPdf, expect, journey } from './driver';

const PAPER = 'J35 paper.pdf';
const NOTE = 'J35 note.md';
const ASIDE = 'J35 aside.txt';

/** Two invented sentences, one per page. ASCII, because the PDF is built from them. */
const PAGES = [
  'J35 authored page one: the opening of an invented paper.',
  'J35 authored page two: a sentence worth keeping exactly.',
];
const PAPER_QUOTE = 'a sentence worth keeping exactly';

/** The emoji are the measurement: each is one codepoint and two UTF-16 units. */
const NOTE_TEXT = '# J35 authored note\n'
  + 'Before the passage come an owl \u{1F989} and a comet ☄️, '
  + 'then the passage itself: keep this line exact.\n'
  + 'After it, nothing that matters.\n';
const NOTE_QUOTE = 'keep this line exact';

/** A file the export leaves out, with a marker that must not appear in it. */
const ASIDE_MARKER = 'J35-UNSELECTED-MARKER';
const ASIDE_TEXT = `${ASIDE_MARKER}: an invented aside that belongs to no export.\n`;
const ASIDE_NOTE = `${ASIDE_MARKER} note, kept against the file the export leaves out.`;

journey.describe('J35 Evidence workspace', () => {
  journey('a passage is pinned to its exact characters, reopens on them after a relaunch, and an export carries only what was chosen', async ({ resmon }) => {
    await resmon.chooseAParentFolderForTheLibrary();
    await resmon.createTheManagedVault();
    const imported = await resmon.importIntoTheLibrary([
      { name: PAPER, content: authoredPdf(PAGES) },
      { name: NOTE, content: NOTE_TEXT },
      { name: ASIDE, content: ASIDE_TEXT },
    ]);
    expect(imported).toContain('3 retained');
    const library = await resmon.readTheLibraryItems();
    const versionOf = (name: string) => library.find((item) => item.name === name)!;

    // — reading one page, and saying it was one page ---------------------------
    const first = await resmon.startAnEvidenceProjectFrom(PAPER, 'J35 project');
    console.log(`[J35] the reader opened on: ${JSON.stringify(first)}`);
    expect(first.page).toBe(1);
    expect(first.text, 'the canonical text of page 1 is not what the PDF says').toBe(PAGES[0]);
    expect(first.image, 'PDF.js did not draw the page it was asked for').toMatch(/^Page 1 of 2 rendered/);
    expect(first.examined, 'reading one page claimed more than one page was examined')
      .toMatch(/^1 of 2 pages examined by text extraction\. Other pages: not examined\./);

    const held = await resmon.addToTheEvidenceProject([NOTE, ASIDE]);
    expect(held.sort(), 'the collection does not hold the three files added to it')
      .toEqual([ASIDE, NOTE, PAPER].sort());

    // — three records ------------------------------------------------------------
    await resmon.saveAnEvidencePassage({ file: PAPER, page: 2, quote: PAPER_QUOTE, body: 'Kept from page 2.' });
    await resmon.saveAnEvidencePassage({ file: NOTE, quote: NOTE_QUOTE, body: 'Kept from after the owl.' });
    await resmon.saveAnEvidenceNote({ file: ASIDE, body: ASIDE_NOTE });

    // The app's own record of the two passages, against offsets computed here.
    const stored = await resmon.backend.evidenceNotes('J35 project');
    console.log(`[J35] stored records: ${JSON.stringify(stored.map((n) => ({
      kind: n.kind, file: n.file_id, page: n.page_number, start: n.start_codepoint, end: n.end_codepoint, quote: n.quote,
    })))}`);
    expect(stored).toHaveLength(3);
    const codepoints = (text: string) => Array.from(text).length;
    const prefix = NOTE_TEXT.slice(0, NOTE_TEXT.indexOf(NOTE_QUOTE));
    // The fixture's own precondition: if these two agreed, this row could not
    // tell a codepoint offset from a UTF-16 one.
    expect(codepoints(prefix), 'the note no longer separates codepoints from UTF-16 units')
      .not.toBe(prefix.length);
    const notePassage = stored.find((n) => n.quote === NOTE_QUOTE);
    expect(notePassage, 'the passage from the note was not stored').toBeTruthy();
    expect(notePassage!.page_number).toBe(1);
    expect(notePassage!.start_codepoint, 'the passage is not anchored at its codepoint offset')
      .toBe(codepoints(prefix));
    expect(notePassage!.end_codepoint).toBe(codepoints(prefix) + codepoints(NOTE_QUOTE));
    expect(notePassage!.version_id, 'the passage is not pinned to the version that was read')
      .toBe(versionOf(NOTE).versionId);
    const paperPassage = stored.find((n) => n.quote === PAPER_QUOTE);
    expect(paperPassage, 'the passage from page 2 was not stored').toBeTruthy();
    expect(paperPassage!.page_number, 'the passage is not on the page it was taken from').toBe(2);
    expect(paperPassage!.start_codepoint).toBe(PAGES[1].indexOf(PAPER_QUOTE));
    expect(paperPassage!.version_id).toBe(versionOf(PAPER).versionId);

    // And what a person sees in the panel is the same three records.
    const listed = await resmon.readTheSavedEvidenceNotes();
    console.log(`[J35] the panel lists: ${JSON.stringify(listed)}`);
    expect(listed.map((n) => `${n.file}|${n.kind}|${n.quote ?? ''}`).sort()).toEqual([
      `${ASIDE}|note|`, `${NOTE}|passage|${NOTE_QUOTE}`, `${PAPER}|passage|${PAPER_QUOTE}`,
    ].sort());

    // — close the window, and come back to exactly that text --------------------
    await resmon.reopenTheApp();
    await resmon.openTheEvidenceProject('J35 project');
    for (const [quote, file, page] of [[NOTE_QUOTE, NOTE, 1], [PAPER_QUOTE, PAPER, 2]] as const) {
      const reopened = await resmon.reopenTheSavedPassage(quote);
      console.log(`[J35] reopened after a relaunch: ${JSON.stringify(reopened)}`);
      expect(reopened.file).toBe(file);
      expect(reopened.page, 'the saved passage reopened on another page').toBe(page);
      expect(reopened.highlighted, 'the reader highlighted something other than the saved passage').toBe(quote);
      expect(reopened.resolution).toMatch(/^Saved passage resolved against this exact version/);
    }

    // — the export carries what was chosen, and nothing else --------------------
    const bundle = await resmon.exportSelectedEvidence([PAPER, NOTE], { includeFiles: true });
    console.log(`[J35] the bundle holds: ${JSON.stringify(bundle.members)}`);
    const chosen = [versionOf(PAPER), versionOf(NOTE)];
    const contentPath = (item: (typeof chosen)[number]) =>
      `files/${item.fileId}/${item.versionId}.${item.mediaType === 'application/pdf' ? 'pdf' : 'md'}`;
    expect([...bundle.members].sort(), 'the archive holds more or less than the contract allows')
      .toEqual(['manifest.json', 'notes.md', ...chosen.map(contentPath)].sort());
    const manifestFiles = bundle.manifest.files;
    expect(manifestFiles.map((f) => f.file_id).sort()).toEqual(chosen.map((item) => item.fileId).sort());
    const exportedNotes = manifestFiles.flatMap((f) => f.notes.map((n) => n.note_id)).sort();
    expect(exportedNotes, 'the manifest does not carry exactly the chosen files\' records')
      .toEqual([notePassage!.note_id, paperPassage!.note_id].sort());
    for (const item of chosen) {
      expect(bundle.hashes[contentPath(item)], `${item.name} in the archive is not the bytes the Library holds`)
        .toBe(item.sha256);
    }
    // The file that was left out is absent in every form: its bytes, its
    // name, its note and the marker inside it.
    const everything = JSON.stringify(bundle.manifest) + bundle.notesMarkdown;
    expect(everything, 'something of the file that was left out is in the export').not.toContain(ASIDE_MARKER);
    expect(everything).not.toContain(ASIDE);

    console.log('[J35] NOT VERIFIED: the native folder chooser and the save dialog. Both are '
      + 'answered by the driver — the production handlers are left in place and only their OS '
      + 'dependency answers — so the request, the bytes and the download are the app\'s and a '
      + 'person pressing Choose or Save is not observed here.');
    console.log('[J35] NOT VERIFIED: what the PDF page looks like. PDF.js reports drawing it, and '
      + 'that sentence is asserted; no pixel of the canvas is judged.');
    console.log('[J35] NOT VERIFIED: a real paper. The PDF is two authored lines in a standard '
      + 'font; columns, equations, images and scanned pages are not exercised.');

    await resmon.takePicture('J35-evidence-workspace');
    expect(resmon.refusedConnections()).toEqual([]);
  });
});
