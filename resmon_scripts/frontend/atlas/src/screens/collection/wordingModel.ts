/**
 * The words and the arithmetic of Search › Shared wording, kept out of the
 * screen so they can be held to the engine's.
 *
 * The engine measures and composes the pair's sentences (`shared_wording.py`);
 * this file only lays its numbers out. A share is written as the engine writes
 * it: a whole percent rounded down, so the screen never says more than was
 * measured. Passages arrive as Unicode codepoint offsets into the text the
 * engine compared, and are cut here by codepoint, not by UTF-16 unit, so a
 * character outside the Basic Multilingual Plane cannot shift a highlight.
 */
import type { components } from '../../api/schema';
import { count, number } from '../today/format';

export type SharedWordingOverview = components['schemas']['SharedWording'];
export type SharedWordingBrief = components['schemas']['SharedWordingBrief'];
export type SharedWordingPair = components['schemas']['SharedWordingPair'];
export type SharedWordingJob = components['schemas']['SharedWordingJob'];
export type SharedWordingLibrary = components['schemas']['SharedWordingLibrary'];
export type Category = SharedWordingBrief['category'];

export const WORDING_KEY = ['shared-wording'] as const;

/** The view of one pair, in the address: `?pair=12-345`. */
export function pairParam(a: number, b: number): string {
  return `${Math.min(a, b)}-${Math.max(a, b)}`;
}

export function readPair(value: string | null): [number, number] | null {
  const match = /^(\d+)-(\d+)$/.exec(value ?? '');
  if (!match) return null;
  const a = Number(match[1]);
  const b = Number(match[2]);
  return a > 0 && b > 0 && a !== b ? [Math.min(a, b), Math.max(a, b)] : null;
}

export function pairLink(a: number, b: number): string {
  return `/search/wording?pair=${pairParam(a, b)}`;
}

/** "58%", "100%", "under 1%": rounded down, as the engine writes it. */
export function percentWords(share: number): string {
  if (share <= 0) return '0%';
  const whole = Math.floor(share * 100 + 1e-9);
  return whole === 0 ? 'under 1%' : `${whole}%`;
}

/** "no author in common", "1 author in common", "3 authors in common". */
export function authorsWords(category: Category, n: number): string {
  if (category === 'authors_unknown') return 'authors not listed on one record';
  if (n === 0) return 'no author in common';
  return `${count(n, 'author')} in common`;
}

/** One line of numbers for a pair in a list. */
export function pairLine(pair: Pick<SharedWordingBrief, 'longest' | 'share' | 'authors_in_common' | 'category'>,
  phraseWords: number): string {
  return `${number(pair.longest)}-word passage word for word · ${percentWords(pair.share)} of the shorter `
    + `abstract's ${phraseWords}-word phrases · ${authorsWords(pair.category, pair.authors_in_common)}`;
}

/** What the scan in progress is doing, from its stage and counts. */
export function progressWords(job: SharedWordingJob): string {
  const what = job.kind === 'new' ? 'Comparing new papers with the collection' : 'Scanning the collection';
  if (job.stage === 'measuring') {
    return job.total ? `${what}: measuring ${number(job.done)} of ${count(job.total, 'pair')} that share phrases.`
      : `${what}: measuring the pairs that share phrases.`;
  }
  return job.total ? `${what}: reading ${number(job.done)} of ${count(job.total, 'paper')}.` : `${what}.`;
}

type Scan = NonNullable<SharedWordingOverview['scan']>;

/** What the stored scan compared, and what it did not, as one or two sentences. */
export function comparedWords(scan: Scan, minWords: number): string {
  const compared = scan.compared ?? 0;
  const none = scan.not_compared?.no_abstract ?? 0;
  const short = scan.not_compared?.too_short ?? 0;
  const parts = [`${count(compared, 'abstract was', 'abstracts were')} compared.`];
  const skipped: string[] = [];
  if (none) skipped.push(`${count(none, 'paper has', 'papers have')} no abstract`);
  if (short) skipped.push(`${count(short, 'paper has an abstract', 'papers have abstracts')} under ${minWords} words`);
  if (skipped.length) {
    parts.push(`${skipped.join(' and ')}, so ${none + short === 1 ? 'it was' : `those ${number(none + short)} were`} not compared.`);
  }
  return parts.join(' ');
}

export interface Span {
  start: number;
  end: number;
  passage: number;
}

export interface Segment {
  text: string;
  /** The passages this stretch of text belongs to; empty for unshared text. */
  passages: number[];
}

/**
 * The text cut at every passage's edges. Passages can overlap (a sentence a
 * text repeats is shared twice), so a stretch lists every passage it is in.
 */
export function segments(text: string, spans: readonly Span[]): Segment[] {
  const points = Array.from(text);
  const edges = new Set<number>([0, points.length]);
  for (const span of spans) {
    edges.add(Math.max(0, Math.min(points.length, span.start)));
    edges.add(Math.max(0, Math.min(points.length, span.end)));
  }
  const sorted = [...edges].sort((x, y) => x - y);
  const out: Segment[] = [];
  for (let i = 0; i + 1 < sorted.length; i += 1) {
    const from = sorted[i]!;
    const to = sorted[i + 1]!;
    if (to <= from) continue;
    const passages = spans.filter((s) => s.start <= from && s.end >= to).map((s) => s.passage);
    const piece = points.slice(from, to).join('');
    const last = out[out.length - 1];
    if (last && last.passages.join(',') === passages.join(',')) last.text += piece;
    else out.push({ text: piece, passages });
  }
  return out;
}

/** "Page 2", or "Page 2 of other.pdf, page 1" for a match in another file. */
export function libraryMatchWords(match: components['schemas']['SharedWordingFileMatch']): string {
  const passage = `${number(match.longest)}-word passage word for word`;
  return `Page ${match.page} · ${passage} · ${percentWords(match.share)} of the shorter text's phrases`;
}

/** What a Library comparison in progress is doing. */
export function libraryProgressWords(state: SharedWordingLibrary): string {
  const stage = state.stage ?? 'starting';
  const done = state.done ?? 0;
  const total = state.total ?? 0;
  if (stage === 'reading abstracts') return `Comparing with the abstracts: ${number(done)} of ${number(total)} read.`;
  if (stage === 'reading the other files') return `Comparing with the other files: ${number(done)} of ${number(total)} read.`;
  if (stage === 'measuring') return `Measuring ${number(done)} of ${count(total, 'abstract')} that share phrases with this file.`;
  if (stage === 'reading this file') return 'Reading this file, page by page.';
  return 'Starting the comparison.';
}
