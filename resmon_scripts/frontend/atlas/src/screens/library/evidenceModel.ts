/**
 * What makes a passage exact: its page's canonical text, by hash, and the
 * Unicode codepoint offsets of its quote in that text.
 *
 * A browser selection is counted in UTF-16 units, and a codepoint outside the
 * Basic Multilingual Plane (an emoji, say) is two of them, so the offsets the
 * engine stores are counted again here in codepoints. The engine recomputes
 * the quote from the retained bytes before it saves anything, and refuses a
 * passage that does not match. The same rules as the classic reader's
 * `selectionAnchor` and `resolveSaved`, which go at the switch-over.
 */
import type { Anchor, Note, PageText } from './evidenceApi';

/** The anchor for a selection in a page's text, or null where none can be pinned. */
export function selectionAnchor(page: PageText, start: number, end: number): Anchor | null {
  if (page.status !== 'extracted' || !page.page_text_sha256 || start < 0 || end <= start || end > page.text.length) return null;
  const quote = page.text.slice(start, end);
  const prefix = page.text.slice(0, start);
  // A selection that splits a surrogate pair has no codepoint boundary to pin.
  if (/[\uD800-\uDFFF]/u.test(quote + prefix) || Array.from(quote).length > 20_000) return null;
  return {
    page_number: page.page_number,
    extraction_contract: page.extraction_contract,
    page_text_sha256: page.page_text_sha256,
    start_codepoint: Array.from(prefix).length,
    end_codepoint: Array.from(page.text.slice(0, end)).length,
    quote,
  };
}

/** Whether a saved passage is exactly this page's text, at its range: version, contract, hash and quote. */
export function resolves(note: Note, page: PageText): boolean {
  return note.kind === 'passage'
    && note.file_id === page.file_id && note.version_id === page.version_id && note.file.sha256 === page.sha256
    && note.page_number === page.page_number && note.extraction_contract === page.extraction_contract
    && note.page_text_sha256 === page.page_text_sha256
    && Array.from(page.text).slice(note.start_codepoint ?? 0, note.end_codepoint ?? 0).join('') === note.quote;
}

/** A codepoint range as the UTF-16 range a text field selects. */
export function utf16Range(text: string, start: number, end: number): [number, number] {
  const chars = Array.from(text);
  return [chars.slice(0, start).join('').length, chars.slice(0, end).join('').length];
}

/** "1 of 2 pages examined by text extraction. Other pages: not examined." Every page examined says only the first sentence. */
export function examinedWords(page: PageText): string {
  const examined = `${page.examined_pages.length} of ${page.page_count ?? 'an unknown number of'} ${page.page_count === 1 ? 'page' : 'pages'} examined by text extraction.`;
  return page.page_count !== null && page.examined_pages.length >= page.page_count ? examined : `${examined} Other pages: not examined.`;
}

/** A page status the engine reports, in words; only `extracted` has text a passage can be taken from. */
export const PAGE_STATUS: Record<string, string> = {
  extracted: 'Text extracted',
  no_text: 'No text on this page. That is not evidence the page has no content.',
  unsupported: 'This file cannot be read here.',
  malformed: 'The file is malformed, so nothing was read from it.',
  limit_exceeded: 'Reading this page went past the engine’s bounds, so nothing was kept.',
  timeout: 'Reading this page took too long, so it was stopped.',
  unavailable: 'This page could not be read.',
};
