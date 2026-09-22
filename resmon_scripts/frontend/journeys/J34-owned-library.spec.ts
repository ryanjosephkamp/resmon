/**
 * J34 Owned Library — a vault the person owns: created where they said, holding
 * the bytes they gave it, under the layout the contract describes, with the
 * links they made still there after the window has been closed.
 *
 * The register row's word is *owned*, and that is a claim about a directory
 * rather than about a database. So the two halves are read from two places on
 * purpose: what the app says is read off the screen, and what is actually on
 * the disk is read off the disk. An API that described a layout it had not
 * written would pass a journey that only asked the API.
 *
 * **The layout is quoted, not invented.** `docs/api-contract/library.md` says
 * the server creates `resmon-library-<vault UUID>`, a `vault.json` marker
 * containing exactly `{"version":1,"vault_id":"<UUID>"}`, and `files/`, and
 * that a retained file lives at `files/<file UUID>/<version UUID>.<pdf|txt|md>`.
 * Those four sentences are the four assertions below, and the contract file in
 * the build under test is their denominator.
 *
 * **The hashes are read where a person reads them** — the item's own detail —
 * and checked against the bytes on the disk, which is the only way "these are
 * the bytes I gave it" is a measurement rather than a restatement.
 *
 * **Three things this row does not establish**, printed at the end.
 *
 * *The native folder chooser.* Nothing automated can operate a macOS file
 * dialog. The production IPC handler is untouched and only its OS dependency
 * answers, exactly as `e2e/library.spec.ts` does it — so the request, the
 * refusal of an existing folder and the creation are the app's, and the person
 * pressing Choose in Finder is not.
 *
 * *What is inside the PDF.* The imported PDF is an authored envelope, not a
 * parser fixture. This row is about retention and identity; reading a PDF is
 * J35's, in Evidence.
 *
 * *Surviving the machine rather than the window.* This row closes and reopens
 * the app over the same state directory. It does not move the vault, restore
 * it, or open it from a second installation.
 */
import { expect, journey } from './driver';

/** A markdown note and a PDF envelope. Both authored; neither is a fixture. */
const IMPORTS = [
  { name: 'J34 owned note.md', content: '# An owned note\nUnicode λ, and a line to hash.\n' },
  { name: 'J34 owned paper.pdf', content: '%PDF-1.4\n% authored envelope, not a parser fixture\n%%EOF' },
];

/** `resmon-library-<uuid>`, `files/<uuid>/<uuid>.<ext>` — from the contract. */
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

journey.describe('J34 Owned Library', () => {
  journey('a vault under the chosen parent, holding what was imported, surviving a relaunch', async ({ resmon }) => {
    // A corpus to link to. The dive is a real run against the authored source,
    // which is where the paper a Library item gets associated with comes from.
    const run = await resmon.runDive({ source: 'arxiv', keywords: ['journey'] });
    await resmon.waitForRunToSettle(run);
    const corpus = await resmon.backend.corpusCounts();
    console.log(`[J34] the corpus holds ${corpus.documents} paper(s) to associate with`);
    expect(corpus.documents, 'the dive left no paper to associate a Library item with')
      .toBeGreaterThan(0);

    const parent = await resmon.chooseAParentFolderForTheLibrary();
    console.log(`[J34] the chosen parent folder is ${parent}`);
    const vault = await resmon.createTheManagedVault();
    console.log(`[J34] the app created ${vault}`);
    expect(vault.startsWith(parent), 'the vault was not created under the folder that was chosen')
      .toBe(true);

    const imported = await resmon.importIntoTheLibrary(IMPORTS);
    console.log(`[J34] the page's own account of the import: ${JSON.stringify(imported)}`);
    expect(imported).toContain(`${IMPORTS.length} retained`);
    expect(imported).toContain('0 exact duplicates');

    // What the person can see about each item, from its own detail.
    const items = await resmon.readTheLibraryItems();
    console.log(`[J34] the Library lists ${items.length} item(s): ${JSON.stringify(items)}`);
    expect(items.map((item) => item.name).sort()).toEqual(IMPORTS.map((f) => f.name).sort());
    expect(items.map((item) => item.mediaType).sort())
      .toEqual(['application/pdf', 'text/markdown']);
    for (const item of items) {
      expect(item.sha256, `${item.name} lists no hash for the bytes that were imported`)
        .toMatch(/^[0-9a-f]{64}$/);
      expect(item.fileId).toMatch(new RegExp(`^${UUID}$`));
      expect(item.versionId).toMatch(new RegExp(`^${UUID}$`));
    }
    // Two files, two hashes: a page that showed one hash for everything would
    // satisfy every assertion above.
    expect(new Set(items.map((item) => item.sha256)).size,
      'two different files were listed under one hash').toBe(items.length);

    // The disk, independently of anything the app said about it. Four claims,
    // one per sentence of `docs/api-contract/library.md`.
    const onDisk = await resmon.readTheVaultOnDisk();
    console.log(`[J34] the vault on disk: ${JSON.stringify(onDisk)}`);
    expect(onDisk.directory, 'the directory is not named as the contract says it is')
      .toMatch(new RegExp(`^resmon-library-${UUID}$`));
    expect(onDisk.entries, 'the contract\'s `files/` directory is not there').toContain('files');
    const marker = JSON.parse(onDisk.marker) as Record<string, unknown>;
    expect(Object.keys(marker).sort(), 'the marker carries more than the contract says it does')
      .toEqual(['vault_id', 'version']);
    expect(marker.version).toBe(1);
    expect(String(marker.vault_id)).toMatch(new RegExp(`^${UUID}$`));
    // `files/<file UUID>/<version UUID>.<pdf|txt|md>`, and nothing else with
    // bytes in it. The denominator is the entry list read off the disk.
    const retained = onDisk.entries.filter((entry) => /\.(pdf|txt|md)$/.test(entry));
    console.log(`[J34] ${retained.length} retained file(s) of ${onDisk.entries.length} entries: `
      + JSON.stringify(retained));
    expect(retained).toHaveLength(IMPORTS.length);
    for (const item of items) {
      const at = `files/${item.fileId}/${item.versionId}.${
        item.mediaType === 'application/pdf' ? 'pdf' : 'md'}`;
      expect(retained, `${item.name} is not at the path the contract describes`).toContain(at);
      // The hash on the screen is the hash of the bytes in the folder. Without
      // this the row would only be comparing the page with itself.
      expect(onDisk.hashes[at], `${item.name}'s hash on screen is not its hash on disk`)
        .toBe(item.sha256);
    }
    for (const entry of retained) {
      expect(entry, 'a retained file is not under files/<file>/<version>.<ext>')
        .toMatch(new RegExp(`^files/${UUID}/${UUID}\\.(pdf|txt|md)$`));
    }

    // Associate one item with a paper this app actually holds, and close the
    // window over it.
    const note = items.find((item) => item.name.endsWith('.md'))!;
    const linked = await resmon.associateTheLibraryItemWithPaper(note.name, 1);
    console.log(`[J34] the association the page reported: ${JSON.stringify(linked)}`);
    expect(linked, 'the page claims to have verified a publication identity')
      .toContain('not verified publication identity');

    await resmon.reopenTheApp();
    const afterRelaunch = await resmon.readTheLibraryItems();
    console.log(`[J34] after a relaunch: ${JSON.stringify(afterRelaunch)}`);
    const noteAgain = afterRelaunch.find((item) => item.name === note.name);
    expect(noteAgain, 'the imported note is not in the Library after a relaunch').toBeTruthy();
    expect(noteAgain!.sha256, 'the note came back under a different hash').toBe(note.sha256);
    expect(noteAgain!.versionId, 'the note came back as a different version').toBe(note.versionId);
    expect(noteAgain!.associations.join(' '), 'the link to a paper did not survive the relaunch')
      .toContain('Paper 1');
    // And the bytes are still where the contract says they are.
    const diskAgain = await resmon.readTheVaultOnDisk();
    expect(diskAgain.entries, 'the vault lost or gained files across the relaunch')
      .toEqual(onDisk.entries);
    expect(diskAgain.marker).toBe(onDisk.marker);
    expect(diskAgain.hashes, 'the retained bytes changed across the relaunch')
      .toEqual(onDisk.hashes);

    console.log('[J34] NOT VERIFIED: the native folder chooser. Nothing automated can operate a '
      + 'macOS file dialog, so the production IPC handler is left in place and only its OS '
      + 'dependency answers — the same seam `e2e/library.spec.ts` uses. The request, the refusal '
      + 'to adopt an existing folder and the creation are the app\'s; a person pressing Choose in '
      + 'Finder is not observed here.');
    console.log('[J34] NOT VERIFIED: anything about what is inside the imported PDF. It is an '
      + 'authored envelope, not a parser fixture, and this row is about retention and identity. '
      + 'Reading a PDF is J35\'s journey, in Evidence.');
    console.log('[J34] NOT VERIFIED: that the vault survives the machine rather than the window. '
      + 'This row closes and reopens the app over the same state directory; it does not move the '
      + 'vault, restore it, or open it from a second installation.');

    await resmon.takePicture('J34-owned-library');
    expect(resmon.refusedConnections()).toEqual([]);
  });
});
