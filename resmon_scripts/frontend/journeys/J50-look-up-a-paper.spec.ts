/** One paper found, its source answers distinguished, and its licensed PDF kept. */
import { expect, journey } from './driver';

const DOI = '10.5555/resmon.journey.find';
const TITLE = 'An authored paper about finding one licensed open copy';
const WITHOUT_LICENSE = 'An authored paper whose open copy states no license';

journey.use({ sourceReply: 'find' });

journey.describe('J50 Look Up a Paper', () => {
  journey('an identifier and a title are read as such, and only a licensed copy is kept', async ({ resmon }) => {
    const identifier = await resmon.readHowFindReads(`https://doi.org/${DOI}`);
    expect(identifier.kind).toBe('doi');
    expect(identifier.words).toContain(`Reads as a DOI ${DOI}.`);
    const title = await resmon.readHowFindReads(WITHOUT_LICENSE);
    expect(title.kind).toBe('title');
    expect(title.words).toContain('Reads as a title.');

    await resmon.chooseAParentFolderForTheLibrary();
    await resmon.createTheManagedVault();
    const found = await resmon.findPaper(DOI, ['openalex', 'crossref', 'datacite']);
    const reading = await resmon.readTheFind(found);
    const record = await resmon.backend.find(found);
    expect(record.query).toMatchObject({ kind: 'doi', value: DOI });
    expect(record.status).toBe('completed');
    expect(reading.sources.map(({ source, outcome }) => ({ source, outcome })))
      .toEqual(record.sources.map(({ source, outcome }) => ({ source, outcome })));
    expect(reading.title).toBe(TITLE);
    expect(reading.details).toContain('Ada Fixture');
    expect(reading.details).toContain('October 1, 2026');
    const outcomes = { openalex: 'found', datacite: 'not_found', crossref: 'did_not_answer', arxiv: 'not_asked' };
    const marks: string[] = [];
    for (const [source, outcome] of Object.entries(outcomes)) {
      const drawn = reading.sources.find((s) => s.source === source)!;
      expect(drawn, `the find omitted ${source}`).toBeTruthy();
      expect(drawn.outcome).toBe(outcome);
      expect(record.sources.find((s) => s.source === source)?.outcome).toBe(outcome);
      expect(drawn.mark).not.toBe('');
      marks.push(drawn.mark);
    }
    expect(new Set(marks).size, 'four different answers share a mark').toBe(4);
    expect(reading.sources.find((s) => s.source === 'openalex')!.label).toBe('Found by its DOI');
    expect(reading.sources.find((s) => s.source === 'datacite')!.label).toBe('Not found: it answered with nothing');
    expect(reading.sources.find((s) => s.source === 'crossref')!.label).toBe('Did not answer');
    expect(reading.sources.find((s) => s.source === 'arxiv')!.label).toContain('Not asked');
    expect(reading.pdf.canGet).toBe(true);
    expect(reading.pdf.words).toContain('CC BY');
    expect(record.sources.find((s) => s.source === 'openalex')).toMatchObject({
      matched_by: 'doi', open_copy: { downloadable: true, license: 'cc-by', license_words: 'CC BY' },
    });
    const paperId = record.reference_document_id!;
    expect(paperId).toBeGreaterThan(0);
    const paper = await resmon.backend.paper(paperId);
    expect(paper.title).toBe(TITLE);
    expect(paper.authors).toContain('Ada Fixture');
    expect(paper.publication_date).toBe('2026-10-01');
    await resmon.takePicture('J50-look-up-a-paper-licensed-copy');

    await resmon.getTheFoundPdf(found);
    const fullText = await resmon.backend.fullTextForPaper(paperId);
    expect(fullText.download).toMatchObject({ state: 'stored', license: 'cc-by', license_words: 'CC BY' });
    expect(fullText.in_library).not.toBeNull();
    const files = await resmon.backend.libraryFiles();
    expect(files).toHaveLength(1);
    const file = files[0]!;
    expect(file.file_id).toBe(fullText.in_library!.file_id);
    expect(file.media_type).toBe('application/pdf');
    expect(file.byte_size).toBeGreaterThan(0);
    expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(file.paper_links.map((link) => link.document_id)).toContain(paperId);
    const listed = await resmon.readTheLibraryItems();
    expect(listed.map((item) => item.fileId)).toContain(file.file_id);
    expect(listed.find((item) => item.fileId === file.file_id)!.sha256).toBe(file.sha256);
    const onDisk = await resmon.readTheVaultOnDisk();
    expect(Object.values(onDisk.hashes)).toContain(file.sha256);

    const unlicensed = await resmon.findPaper(WITHOUT_LICENSE, ['openalex']);
    const noLicense = await resmon.readTheFind(unlicensed);
    const unlicensedRecord = await resmon.backend.find(unlicensed);
    expect(unlicensedRecord.query.kind).toBe('title');
    expect(unlicensedRecord.sources.find((s) => s.source === 'openalex')!.matched_by).toBe('exact_title');
    expect(noLicense.title).toBe(WITHOUT_LICENSE);
    expect(noLicense.pdf.canGet).toBe(false);
    expect(noLicense.pdf.canRead).toBe(false);
    expect(noLicense.pdf.words).toContain('No source states an open license');
    const refused = await resmon.backend.fullTextForPaper(unlicensedRecord.reference_document_id!);
    expect(refused.downloadable).toBe(false);
    expect(refused.why_not).toBe('no_license');
    expect(refused.download).toBeNull();
    expect(await resmon.backend.libraryFiles()).toHaveLength(1);
    await resmon.takePicture('J50-look-up-a-paper-unlicensed-copy');
    const earlier = await resmon.readEarlierFinds();
    expect(earlier).toEqual(expect.arrayContaining([
      { id: found.id, query: DOI }, { id: unlicensed.id, query: WITHOUT_LICENSE },
    ]));
    console.log(`[J50] ${reading.sources.length} source outcomes read; licensed PDF ${file.file_id} kept; unlicensed copy refused.`);
    console.log('[J50] NOT VERIFIED: live source behavior, a publisher license, or the native folder chooser. Metadata and the PDF are authored on loopback; the production downloader verifies this run’s test certificate. The unknown-license case is a non-arXiv copy; arXiv’s license lookup is not exercised.');
    await resmon.takePicture('J50-look-up-a-paper-earlier-finds');
    expect(resmon.refusedConnections()).toEqual([]);
  });
});
