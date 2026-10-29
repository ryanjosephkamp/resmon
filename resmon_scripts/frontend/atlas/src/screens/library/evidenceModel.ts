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

/** A range pinned to one exact page's text: a saved passage, or a citation in a saved answer. */
export interface Pin {
  kind: 'passage' | 'citation';
  file_id: string; version_id: string; sha256: string; page_number: number;
  extraction_contract: string; page_text_sha256: string; start_codepoint: number; end_codepoint: number; quote: string;
}

/** A saved passage as the range it is pinned to; a plain note pins nothing. */
export function pinOf(note: Note): Pin | null {
  if (note.kind !== 'passage' || note.page_number === null || note.extraction_contract === null || note.page_text_sha256 === null
    || note.start_codepoint === null || note.end_codepoint === null || note.quote === null) return null;
  return {
    kind: 'passage', file_id: note.file_id, version_id: note.version_id, sha256: note.file.sha256, page_number: note.page_number,
    extraction_contract: note.extraction_contract, page_text_sha256: note.page_text_sha256,
    start_codepoint: note.start_codepoint, end_codepoint: note.end_codepoint, quote: note.quote,
  };
}

/** Whether a pinned range is exactly this page's text: version, contract, hash and quote at its range. */
export function matches(pin: Pin, page: PageText): boolean {
  return pin.file_id === page.file_id && pin.version_id === page.version_id && pin.sha256 === page.sha256
    && pin.page_number === page.page_number && pin.extraction_contract === page.extraction_contract
    && pin.page_text_sha256 === page.page_text_sha256
    && Array.from(page.text).slice(pin.start_codepoint, pin.end_codepoint).join('') === pin.quote;
}

/** Whether a saved passage is exactly this page's text, at its range. */
export function resolves(note: Note, page: PageText): boolean {
  const pin = pinOf(note);
  return pin !== null && matches(pin, page);
}

/** What the reader says about a pinned range, before and after it has read the page. */
export function resolutionWords(pin: Pin, page: PageText | undefined): string {
  if (pin.kind === 'citation') {
    if (!page) return 'Citation unresolved until this exact page is read.';
    return matches(pin, page)
      ? 'Citation matched this exact current text range. Whether the quote supports the answer is not checked.'
      : 'Saved citation unresolved: this page, its text hash or its extraction contract differs from the one the answer was given. The frozen quote is unchanged.';
  }
  if (!page) return 'Saved passage is unresolved until this exact page is read.';
  return matches(pin, page)
    ? 'Saved passage resolved against this exact version, extraction contract, text hash and codepoint range.'
    : 'Saved passage unresolved: this page, its text hash or its extraction contract does not match. The saved quote is unchanged.';
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
