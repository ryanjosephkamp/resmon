/**
 * The Library's gallery, apart from drawing: which shelf is shown, in what
 * order, how many covers fit a row, what each card's lines say, and which
 * cards a Shift-click picks. Every sentence says only what the engine's
 * answer establishes: a paper's line names the run that first collected it,
 * not where it was saved from, because the queue does not record that.
 */
import type { components } from '../../api/schema';
import { count, instant, number } from '../today/format';

export type QueueEntry = components['schemas']['ReadingQueueEntry'];
export type Project = components['schemas']['EvidenceProject'];
export type LibraryFileRow = components['schemas']['LibraryFile'];

/** The four shelves, in the order the filter shows them. */
export type Show = 'to_read' | 'read' | 'files' | 'projects';
export const SHOWS: readonly { id: Show; label: string }[] = [
  { id: 'to_read', label: 'To read' },
  { id: 'read', label: 'Read' },
  { id: 'files', label: 'Your files' },
  { id: 'projects', label: 'Projects' },
];

export function showFrom(value: string | null): Show {
  return SHOWS.some((s) => s.id === value) ? (value as Show) : 'to_read';
}

/** Each shelf's orders, the default first; the ids are what the engine takes. */
export const SORTS: Record<Show, readonly { id: string; label: string }[]> = {
  to_read: [
    { id: 'saved', label: 'Saved, newest first' },
    { id: 'published', label: 'Published, newest first' },
    { id: 'title', label: 'Title' },
    { id: 'source', label: 'Source' },
    { id: 'map', label: 'Map order' },
  ],
  read: [
    { id: 'saved', label: 'Saved, newest first' },
    { id: 'published', label: 'Published, newest first' },
    { id: 'title', label: 'Title' },
    { id: 'source', label: 'Source' },
    { id: 'map', label: 'Map order' },
  ],
  files: [
    { id: 'newest', label: 'Added, newest first' },
    { id: 'oldest', label: 'Added, oldest first' },
    { id: 'name', label: 'Name' },
    { id: 'size', label: 'Size, largest first' },
  ],
  projects: [
    { id: 'changed', label: 'Changed, newest first' },
    { id: 'name', label: 'Name' },
  ],
};

export function sortFrom(show: Show, value: string | null): string {
  return SORTS[show].some((s) => s.id === value) ? value! : SORTS[show][0]!.id;
}

/** The find field's words, by shelf. */
export const FIND_WORDS: Record<Show, string> = {
  to_read: 'Find by title, author, or source',
  read: 'Find by title, author, or source',
  files: 'Find by file name',
  projects: 'Find a project',
};

export const LEDE: Record<Show, string> = {
  to_read: 'Papers you saved to read, the files you keep, and the projects you build from them.',
  read: 'Papers you saved to read, the files you keep, and the projects you build from them.',
  files: 'Copies of PDFs and text files you keep in your own folder. Nothing is uploaded anywhere.',
  projects: 'Evidence projects: exact versions of your files, the passages you pinned in them, and the answers drawn from those passages.',
};

/** A cover's least width, and the gaps between covers, in CSS pixels, as the comps set them. */
export const CARD_MIN = 220;
export const GAP_X = 24;
export const GAP_Y = 36;
/** Under this width the gallery is two columns with the phone's compact actions. */
export const NARROW = 640;
export const GAP_X_NARROW = 14;
export const GAP_Y_NARROW = 26;

/** How many covers fit a row of this width. */
export function columnsFor(width: number): number {
  if (width <= 0) return 1;
  if (width < NARROW) return 2;
  return Math.max(2, Math.floor((width + GAP_X) / (CARD_MIN + GAP_X)));
}

/** A cover is a page: 8.5 by 11, as US Letter is. */
export const PAGE_RATIO = 792 / 612;

/**
 * A row's height before it is measured: the cover at the column's width, then
 * the caption (title, one line, the label, the actions).
 */
export function rowEstimate(width: number, columns: number): number {
  const narrow = width < NARROW;
  const gap = narrow ? GAP_X_NARROW : GAP_X;
  const card = (width - gap * (columns - 1)) / columns;
  return Math.round(card * PAGE_RATIO + (narrow ? 112 : 120) + (narrow ? GAP_Y_NARROW : GAP_Y));
}

/** "Priya Raman et al.", from the stored, comma-joined names. */
export function shortWho(list: string | null | undefined): string {
  const names = (list ?? '').split(',').map((n) => n.trim()).filter(Boolean);
  if (!names.length) return 'Authors not recorded';
  return names.length > 1 ? `${names[0]} et al.` : names[0]!;
}

/** The year a stored publication date names, or null when it names none. */
export function yearOf(stored: string | null | undefined): string | null {
  const match = /^(\d{4})/.exec((stored ?? '').trim());
  return match ? match[1]! : null;
}

const DAY = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric' });
const DAY_YEAR = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

/** "November 3", or "November 3, 2025" outside this year. */
export function dayOf(iso: string | null | undefined, now: Date): string | null {
  if (!iso) return null;
  const at = instant(iso);
  if (Number.isNaN(at.getTime())) return null;
  return (at.getFullYear() === now.getFullYear() ? DAY : DAY_YEAR).format(at);
}

/**
 * A saved paper's label: the run that first collected it and the day it was
 * saved. A watch's run names the watch, set as a name; a search names no run,
 * since a search has no name; a paper no run is recorded for says only when
 * it was saved.
 */
export function paperLabel(entry: Pick<QueueEntry, 'saved_at' | 'found_by'>, now: Date): { from: string | null; name: boolean; day: string | null } {
  const day = dayOf(entry.saved_at, now);
  const found = entry.found_by;
  if (!found) return { from: null, name: false, day };
  if (found.kind === 'watch') return found.watch_name ? { from: found.watch_name, name: true, day } : { from: 'a watch', name: false, day };
  return { from: 'a search', name: false, day };
}

/** What a kept file is tied to, in one line: its papers, else its projects, else that it is not linked. */
export function fileLabel(file: Pick<LibraryFileRow, 'paper_links' | 'project_count' | 'availability'>): string {
  if (file.availability === 'missing') return 'Not in the Library folder: moved or deleted outside resmon';
  const papers = file.paper_links.length;
  const projects = file.project_count;
  const parts: string[] = [];
  if (papers) parts.push(`Linked to ${count(papers, 'paper')}`);
  if (projects) parts.push(`in ${count(projects, 'project')}`);
  if (!parts.length) return 'Not linked to a paper';
  const said = parts.join(', ');
  return said[0]!.toUpperCase() + said.slice(1);
}

/** A project's counts, as its card and cover say them. */
export function projectCounts(project: Pick<Project, 'file_count' | 'note_count' | 'passage_count'>): string[] {
  const notes = project.note_count - project.passage_count;
  return [
    count(project.file_count, 'file'),
    ...(project.passage_count ? [count(project.passage_count, 'passage')] : []),
    ...(notes ? [count(notes, 'note')] : []),
  ];
}

/** Where a paper can be opened at its source: its stored address when it is a web address, else its DOI's. */
export function sourceUrl(doc: { url?: string | null; doi?: string | null } | null | undefined): string | null {
  const url = (doc?.url ?? '').trim();
  if (/^https?:\/\//i.test(url)) return url;
  const doi = (doc?.doi ?? '').trim();
  return doi ? `https://doi.org/${encodeURI(doi)}` : null;
}

/** The first lines of a text file, as its cover shows them: literal, at most `n`. */
/** How many lines a text file's cover shows. */
export const COVER_LINES = 18;

export function firstLines(text: string, n = COVER_LINES): string[] {
  return text.replace(/\r\n?/g, '\n').split('\n').slice(0, n);
}

/**
 * The cards a click picks. A plain click toggles one card; a Shift-click picks
 * every card from the last one clicked to this one, in the gallery's order,
 * and leaves the others as they were.
 */
export function pick(order: readonly string[], picked: ReadonlySet<string>, anchor: string | null, key: string,
  range: boolean): Set<string> {
  const next = new Set(picked);
  const from = anchor === null ? -1 : order.indexOf(anchor);
  const to = order.indexOf(key);
  if (range && from >= 0 && to >= 0) {
    const [a, b] = from < to ? [from, to] : [to, from];
    for (let i = a; i <= b; i += 1) next.add(order[i]!);
    return next;
  }
  if (next.has(key)) next.delete(key); else next.add(key);
  return next;
}

/** "3 of 14 picked", or "2 picked" where the whole shelf's count is not known. */
export function pickedWords(picked: number, total: number | null): string {
  return total === null ? `${number(picked)} picked` : `${number(picked)} of ${number(total)} picked`;
}

/** How long a removal can be undone from its notice. */
export const UNDO_SECONDS = 10;

/** The notice after a removal: what went, and from where. */
export function removedWords(titles: readonly string[], from: string, stayed: readonly Stayed[] = []): { lead: string; name: string | null; rest: string } {
  const not = stayed.length ? ` ${notRemovedWords(stayed)}` : '';
  if (titles.length === 1) return { lead: 'Removed ', name: titles[0]!, rest: ` from ${from}.${not}` };
  return { lead: `Removed ${number(titles.length)} from ${from}.`, name: null, rest: not };
}

/** One card a removal of several could not take, by its name, and what the engine said. */
export interface Stayed { name: string; why: string }

/** The cards a removal of several could not take: “A” (why); “B” (why). */
export function notRemovedWords(stayed: readonly Stayed[]): string {
  const named = stayed.slice(0, 3).map((s) => `“${s.name}” (${s.why})`).join('; ');
  const more = stayed.length > 3 ? `; and ${count(stayed.length - 3, 'other')}` : '';
  return `${stayed.length === 1 ? 'This one was' : `These ${number(stayed.length)} were`} not removed: ${named}${more}.`;
}

/**
 * Remove each card in turn, carrying on past one that fails: what went, for
 * its Undo, and what stayed, with why. Each card is its own request, so one
 * refused (a file changed outside resmon, a paper already gone) leaves the
 * others to go as asked.
 */
export async function removeEach<T, R>(items: readonly T[], removeOne: (item: T) => Promise<R>, nameOf: (item: T) => string,
  why: (error: unknown) => string): Promise<{ went: R[]; stayed: Stayed[] }> {
  const went: R[] = [];
  const stayed: Stayed[] = [];
  for (const item of items) {
    try {
      went.push(await removeOne(item));
    } catch (error) {
      stayed.push({ name: nameOf(item), why: why(error) });
    }
  }
  return { went, stayed };
}

/**
 * Read a shelf's every page, one after another, for Select all: until the
 * last page, or until the shelf is gone. A page that fails ends it with that
 * failure (`fetchNextPage({ throwOnError: true })`); without that, a failed
 * page answers with the pages it already had, and the shelf would be asked
 * for it again, about once a second, for as long as the window was open.
 */
export async function readEveryPage<R extends { hasNextPage: boolean }>(
  hasNextPage: boolean, next: () => Promise<R>, alive: () => boolean,
): Promise<R | null> {
  let last: R | null = null;
  let more = hasNextPage;
  while (more && alive()) {
    last = await next();
    more = last.hasNextPage;
  }
  return last;
}

/**
 * Whether the gallery asks for its next page by itself: it is near the end of
 * what it has, and the last ask did not fail. After a failure, Show more is
 * the way to ask again, so a page that cannot be read is not asked for again
 * on every render.
 */
export function readsMore({ has, reading, failed, last, rows, ahead }: {
  has: boolean; reading: boolean; failed: boolean; last: number; rows: number; ahead: number;
}): boolean {
  return has && !reading && !failed && rows > 0 && last >= rows - ahead;
}

/** What a confirmation before removing a file says goes with it. */
export function goesWith(summary: {
  links: readonly unknown[];
  projects: readonly { name: string; member: boolean; notes: number; passages: number }[];
}): string[] {
  const lines = summary.projects.map((p) => {
    const kept = [
      ...(p.member ? ['its place in the project'] : []),
      ...(p.passages ? [count(p.passages, 'passage')] : []),
      ...(p.notes ? [count(p.notes, 'note')] : []),
    ];
    return `${p.name}: ${kept.join(', ')}`;
  });
  const links = summary.links.length;
  if (links) lines.push(links === 1 ? 'Its link to a paper in your collection' : `Its ${number(links)} links to papers in your collection`);
  return lines;
}
