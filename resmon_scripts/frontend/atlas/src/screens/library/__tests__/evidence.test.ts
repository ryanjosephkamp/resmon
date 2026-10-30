import { EvidenceRefusal, type Note, type PageText } from '../evidenceApi';
import { bundleRefusal, examinedWords, resolves, selectionAnchor, utf16Range } from '../evidenceModel';

/** One page's canonical text: an emoji and a decomposed é before the passage, so UTF-16 and codepoints differ. */
const TEXT = 'First \u{1F600} é exact passage\nrepeat needle\n';
const QUOTE = 'exact passage';

const page = (over: Partial<PageText> = {}): PageText => ({
  status: 'extracted', page_number: 1, page_count: 1, text: TEXT, extraction_contract: 'text-v1',
  page_text_sha256: 'a'.repeat(64), examined_pages: [1], file_id: 'f1', version_id: 'v1', sha256: 'b'.repeat(64),
  ...over,
} as PageText);

const passage = (over: Partial<Note> = {}): Note => ({
  kind: 'passage', file_id: 'f1', version_id: 'v1', file: { sha256: 'b'.repeat(64) }, page_number: 1,
  extraction_contract: 'text-v1', page_text_sha256: 'a'.repeat(64), start_codepoint: 11, end_codepoint: 24, quote: QUOTE,
  ...over,
} as Note);

test('a selection is pinned by codepoints, not by the UTF-16 units a text field counts', () => {
  const at = TEXT.indexOf(QUOTE);
  expect(at).toBe(12);
  const anchor = selectionAnchor(page(), at, at + QUOTE.length);
  expect(anchor).toEqual({
    page_number: 1, extraction_contract: 'text-v1', page_text_sha256: 'a'.repeat(64),
    start_codepoint: 11, end_codepoint: 24, quote: QUOTE,
  });
  expect(utf16Range(TEXT, 11, 24)).toEqual([at, at + QUOTE.length]);
});

test('nothing is pinned to half an emoji, an empty selection, or a page without extracted text', () => {
  const emoji = TEXT.indexOf('\u{1F600}');
  expect(selectionAnchor(page(), emoji + 1, emoji + 5)).toBeNull();
  expect(selectionAnchor(page(), 4, 4)).toBeNull();
  expect(selectionAnchor(page({ status: 'no_text', page_text_sha256: null }), 0, 5)).toBeNull();
});

test('a saved passage resolves only against the same version, contract, hash and quote', () => {
  expect(resolves(passage(), page())).toBe(true);
  expect(resolves(passage({ version_id: 'v2' }), page())).toBe(false);
  expect(resolves(passage({ page_text_sha256: 'c'.repeat(64) }), page())).toBe(false);
  expect(resolves(passage({ extraction_contract: 'text-v2' }), page())).toBe(false);
  expect(resolves(passage({ start_codepoint: 12, end_codepoint: 25 }), page())).toBe(false);
  expect(resolves(passage({ kind: 'note' }), page())).toBe(false);
});

test('what text extraction did with the page on screen, and no word about pages it has not read', () => {
  expect(examinedWords(page({ page_count: 2 }))).toBe('Page 1 of 2, read by text extraction. Each page is read when you open it.');
  expect(examinedWords(page())).toBe('Page 1 of 1, read by text extraction.');
  expect(examinedWords(page({ page_count: null }))).toBe(
    'Page 1, read by text extraction; how many pages the file has is not known. Each page is read when you open it.');
  // Each request reads one page: the second page read says it is page 2, not "1 of 7 pages examined".
  expect(examinedWords(page({ page_number: 2, page_count: 7, examined_pages: [2] })))
    .toBe('Page 2 of 7, read by text extraction. Each page is read when you open it.');
  // A page with no text was still read; one that could not be read is not called read.
  expect(examinedWords(page({ status: 'no_text', page_text_sha256: null, page_count: 3, examined_pages: [1] })))
    .toBe('Page 1 of 3, read by text extraction. Each page is read when you open it.');
  expect(examinedWords(page({ status: 'malformed', page_number: 3, page_count: 7, examined_pages: [] })))
    .toBe('Text extraction could not read page 3 of 7.');
});

describe('a refused export, in words a person can act on', () => {
  const refused = (reason: string, sentence: string) => new EvidenceRefusal(422, 'Evidence answered HTTP 422', sentence, reason);

  test('a request the engine would not read is a choice that no longer matches the project', () => {
    const words = bundleRefusal(refused('invalid_body', 'Use the exact typed Evidence fields and stated text limits.'));
    expect(words).not.toContain('typed Evidence fields');
    expect(words).toContain('1 to 20 of the files this project holds now');
    expect(bundleRefusal(refused('selection_limit', 'Select 1–20 distinct current files.'))).toBe(words);
  });

  test('a changed project says it was read again', () => {
    expect(bundleRefusal(refused('stale_revision', 'The project changed. Refresh before selecting a bundle.')))
      .toMatch(/^The project changed after this choice was made, so nothing was saved\. It has been read again/);
  });

  test('anything else is the engine’s own sentence', () => {
    expect(bundleRefusal(refused('bundle_limit', 'Selected retained files exceed 256 MiB.'))).toBe('Selected retained files exceed 256 MiB.');
    expect(bundleRefusal(new Error('Network down'))).toBe('Network down');
  });
});
