import type { Note, PageText } from '../evidenceApi';
import { examinedWords, resolves, selectionAnchor, utf16Range } from '../evidenceModel';

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

test('how much of a document text extraction looked at, and no word about pages there are not', () => {
  expect(examinedWords(page({ page_count: 2 }))).toBe('1 of 2 pages examined by text extraction. Other pages: not examined.');
  expect(examinedWords(page())).toBe('1 of 1 page examined by text extraction.');
  expect(examinedWords(page({ page_count: null }))).toBe(
    '1 of an unknown number of pages examined by text extraction. Other pages: not examined.');
});
