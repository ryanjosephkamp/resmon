/**
 * Find in a PDF: each page's text as PDF.js extracts it, folded for matching,
 * and where a match is in the runs of text PDF.js's text layer draws.
 *
 * A page's text is its runs (the `str` of each text item) in order. For
 * matching, every run is folded the way a person searching expects: case and
 * accents ignored, ligatures and full-width forms read as their letters, any
 * run of whitespace one space, and a line that ends in a hyphen joined to the
 * next, the hyphen kept as a mark that matches a hyphen or nothing. Each folded
 * character remembers the character of the runs it came from, so a match is
 * the runs and offsets the text layer has, however many lines it spans.
 */

/** One text run of a page, as `getTextContent` gives it. */
export interface Run { str: string; hasEOL: boolean }

/** A page's text folded for matching, and where each folded character came from. */
export interface FindText {
  /** The folded text. */
  text: string;
  /** For each folded character, its offset in the runs joined end to end. */
  origin: Uint32Array;
  /** Where each run starts in the runs joined end to end. */
  starts: Uint32Array;
}

/** A match, from one place in the runs to another: run index and UTF-16 offset in it, end exclusive. */
export interface Hit { from: [number, number]; to: [number, number] }

/** A hyphen that ended a line, folded: it matches a hyphen in the query, or nothing. */
const JOIN = '­';
const HYPHENS = new Set(['-', '­', '‐', '‑']);

/** One character as matching sees it: no case, no accents, no ligature. */
export function fold(ch: string): string {
  if (HYPHENS.has(ch)) return '-';
  return ch.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}

export function findText(runs: readonly Run[]): FindText {
  let text = '';
  const origin: number[] = [];
  const starts = new Uint32Array(runs.length);
  let flat = 0;
  runs.forEach((run, r) => {
    starts[r] = flat;
    for (let i = 0; i < run.str.length;) {
      const point = run.str.codePointAt(i)!;
      const ch = String.fromCodePoint(point);
      if (/\s/u.test(ch)) {
        if (text && !text.endsWith(' ')) { text += ' '; origin.push(flat + i); }
      } else {
        for (const f of fold(ch)) { text += f; origin.push(flat + i); }
      }
      i += ch.length;
    }
    flat += run.str.length;
    if (run.hasEOL && text) {
      if (text.endsWith('-')) text = `${text.slice(0, -1)}${JOIN}`;
      else if (!text.endsWith(' ')) { text += ' '; origin.push(Math.max(0, flat - 1)); }
    }
  });
  return { text, origin: Uint32Array.from(origin), starts };
}

function escape(ch: string): string {
  return /[.*+?^${}()|[\]\\/]/.test(ch) ? `\\${ch}` : ch;
}

/**
 * What a query matches, or null for a query of nothing. Folded as the text is;
 * a space matches a space or none, since a PDF does not always put one between
 * words it sets apart; a hyphen matches a hyphen, also one that ended a line;
 * and between any two characters a line-ending hyphen may stand, so a word
 * broken across lines is found whole.
 */
export function findPattern(query: string): RegExp | null {
  const folded = Array.from(query.trim().replace(/\s+/gu, ' ')).map((ch) => (ch === ' ' ? ' ' : fold(ch))).join('');
  if (!folded) return null;
  const parts = Array.from(folded).map((ch) => (ch === ' ' ? ' ?' : ch === '-' ? `[-${JOIN}]` : escape(ch)));
  return new RegExp(parts.join(`${JOIN}?`), 'gu');
}

/** The run and offset of a place in the runs joined end to end. */
function place(page: FindText, flat: number): [number, number] {
  let lo = 0;
  let hi = page.starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (page.starts[mid]! <= flat) lo = mid; else hi = mid - 1;
  }
  return [lo, flat - page.starts[lo]!];
}

/** Every match on one page, in order, never overlapping. */
export function findHits(page: FindText, pattern: RegExp): Hit[] {
  const hits: Hit[] = [];
  pattern.lastIndex = 0;
  for (const match of page.text.matchAll(pattern)) {
    if (!match[0]) continue;
    const from = place(page, page.origin[match.index]!);
    const last = place(page, page.origin[match.index + match[0].length - 1]!);
    hits.push({ from, to: [last[0], last[1] + 1] });
  }
  return hits;
}

/** A match's place in the whole document's order, counted from 1, and the count, from per-page counts. */
export function ordinal(counts: ReadonlyMap<number, number>, page: number, index: number): { n: number; of: number } {
  let before = 0;
  let of = 0;
  for (const [p, c] of counts) {
    of += c;
    if (p < page) before += c;
  }
  return { n: before + index + 1, of };
}

/**
 * The next match from a place, forward or back, wrapping at either end; null
 * when there is none. `counts` is matches by page, of the pages read so far.
 */
export function step(counts: ReadonlyMap<number, number>, at: { page: number; index: number } | null, direction: 1 | -1): { page: number; index: number } | null {
  const pages = Array.from(counts.entries()).filter(([, c]) => c > 0).map(([p]) => p).sort((a, b) => a - b);
  if (!pages.length) return null;
  if (!at) return direction > 0 ? { page: pages[0]!, index: 0 } : { page: pages[pages.length - 1]!, index: counts.get(pages[pages.length - 1]!)! - 1 };
  const here = counts.get(at.page) ?? 0;
  if (direction > 0 && at.index + 1 < here) return { page: at.page, index: at.index + 1 };
  if (direction < 0 && at.index > 0 && here > 0) return { page: at.page, index: Math.min(at.index - 1, here - 1) };
  const after = direction > 0 ? pages.find((p) => p > at.page) ?? pages[0]! : [...pages].reverse().find((p) => p < at.page) ?? pages[pages.length - 1]!;
  return { page: after, index: direction > 0 ? 0 : counts.get(after)! - 1 };
}

/** The first match at or after a page, wrapping; null when there is none. */
export function firstFrom(counts: ReadonlyMap<number, number>, page: number): { page: number; index: number } | null {
  const pages = Array.from(counts.entries()).filter(([, c]) => c > 0).map(([p]) => p).sort((a, b) => a - b);
  if (!pages.length) return null;
  return { page: pages.find((p) => p >= page) ?? pages[0]!, index: 0 };
}

/** The pages in the order to read them: from the one on screen to the end, then from the start. */
export function readingOrder(pages: number, from: number): number[] {
  const start = Math.min(Math.max(from, 1), pages);
  return [...Array.from({ length: pages - start + 1 }, (_, i) => start + i), ...Array.from({ length: start - 1 }, (_, i) => i + 1)];
}
