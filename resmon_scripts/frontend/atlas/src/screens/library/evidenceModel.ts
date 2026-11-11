/**
 * What makes a passage exact: its page's canonical text, by hash, and the
 * Unicode codepoint offsets of its quote in that text.
 *
 * A browser selection is counted in UTF-16 units, and a codepoint outside the
 * Basic Multilingual Plane (an emoji, say) is two of them, so the offsets the
 * engine stores are counted again here in codepoints. The engine recomputes
 * the quote from the retained bytes before it saves anything, and refuses a
 * passage that does not match.
 */
import { EngineError } from '../../api/client';
import { EvidenceRefusal, type Anchor, type FileRecord, type Member, type Note, type PageText } from './evidenceApi';

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
      : 'Saved citation unresolved: this page, its text hash, or its extraction contract differs from the one the answer was given. The frozen quote is unchanged.';
  }
  if (!page) return 'Saved passage is unresolved until this exact page is read.';
  return matches(pin, page)
    ? 'Saved passage resolved against this exact version, extraction contract, text hash, and codepoint range.'
    : 'Saved passage unresolved: this page, its text hash, or its extraction contract does not match. The saved quote is unchanged.';
}

/** A codepoint range as the UTF-16 range a text field selects. */
export function utf16Range(text: string, start: number, end: number): [number, number] {
  const chars = Array.from(text);
  return [chars.slice(0, start).join('').length, chars.slice(0, end).join('').length];
}

/**
 * What text extraction did with the page on screen: "Page 2 of 7, read by text
 * extraction." Each request reads the one page it asks for, and
 * `examined_pages` names only that page (`evidence_reader.read_text`), so the
 * words are about that page alone. A count of pages examined would be true of
 * the request and read on screen as how much of the file has been read.
 */
export function examinedWords(page: PageText): string {
  const known = page.page_count !== null;
  const unknown = known ? '' : '; how many pages the file has is not known';
  const of = known ? ` of ${page.page_count}` : '';
  if (!page.examined_pages.includes(page.page_number)) {
    return `Text extraction could not read page ${page.page_number}${of}${unknown}.`;
  }
  const said = `Page ${page.page_number}${of}, read by text extraction${unknown}.`;
  return page.page_count === 1 ? said : `${said} Each page is read when you open it.`;
}

/**
 * A project with no saved records yet, and how one is made, in the words of
 * the notes panel's own buttons.
 */
export const NO_SAVED_RECORDS = 'None yet. Open a file in this project, select a passage in its text, and choose Save Passage. '
  + 'Save Note keeps a note of your own.';

/** A page status the engine reports, in words; only `extracted` has text a passage can be taken from. */
export const PAGE_STATUS: Record<string, string> = {
  extracted: 'Text extracted',
  no_text: 'No text on this page. That is not evidence the page has no content.',
  unsupported: 'The engine does not support text extraction for this page. Other pages and the drawing are checked separately.',
  malformed: 'The text reader could not open this file as a PDF. Drawing is checked separately.',
  limit_exceeded: 'Reading this page went past the engine’s bounds, so nothing was kept.',
  timeout: 'Reading this page took too long, so it was stopped.',
  unavailable: 'This page could not be read.',
};

/**
 * What a refused export means for the person exporting, by the engine's
 * reason. A refusal of the request's shape (`invalid_body`) or of its choice
 * of files is a choice that no longer matches the project; a changed project
 * is read again. Anything else is the engine's own sentence.
 */
export function bundleRefusal(error: unknown): string {
  const reason = error instanceof EvidenceRefusal ? error.reason : null;
  switch (reason) {
    case 'invalid_body':
    case 'invalid_selection':
    case 'selection_limit':
    case 'duplicate_selection':
    case 'not_member':
      return 'resmon could not build the archive from this choice: it must name 1 to 20 of the files this project holds now, each once. Check the files ticked above, then save again.';
    case 'stale_revision':
      return 'The project changed after this choice was made, so nothing was saved. It has been read again; check the files ticked above, then save again.';
    default:
      return error instanceof EngineError && error.detail ? error.detail : error instanceof Error ? error.message : String(error);
  }
}

/** A project's saved records on one exact file version, under that file's heading. */
export interface NoteGroup {
  key: string;
  file: FileRecord;
  /** Whether this exact version is still in the project. */
  member: boolean;
  notes: Note[];
}

/**
 * Saved records grouped by the file they were made against: the project's
 * files in the order they sit in it, then files since removed from it, the one
 * with the newest record first. Within each, the newest record comes first.
 * A record belongs to one exact version, so two versions of one file are two
 * groups.
 */
export function groupByFile(notes: readonly Note[], members: readonly Member[]): NoteGroup[] {
  const place = new Map(members.map((m, i) => [`${m.file_id}:${m.version_id}`, i]));
  const groups = new Map<string, NoteGroup>();
  for (const note of notes) {
    const key = `${note.file_id}:${note.version_id}`;
    let group = groups.get(key);
    if (!group) {
      group = { key, file: note.file, member: place.has(key), notes: [] };
      groups.set(key, group);
    }
    group.notes.push(note);
  }
  for (const group of groups.values()) group.notes.sort((a, b) => b.id - a.id);
  return [...groups.values()].sort((a, b) => {
    const [at, bt] = [place.get(a.key), place.get(b.key)];
    if (at !== undefined && bt !== undefined) return at - bt;
    if (at !== undefined) return -1;
    if (bt !== undefined) return 1;
    return b.notes[0]!.id - a.notes[0]!.id;
  });
}

/** Whether a kept file is found by a find box's words: in its name, or in the title of a paper it is linked to. */
export function fileFound(file: { original_name: string; paper_links?: readonly { title?: string | null }[] }, words: string): boolean {
  const q = words.trim().toLocaleLowerCase('en-US');
  if (!q) return true;
  return file.original_name.toLocaleLowerCase('en-US').includes(q)
    || (file.paper_links ?? []).some((link) => (link.title ?? '').toLocaleLowerCase('en-US').includes(q));
}
