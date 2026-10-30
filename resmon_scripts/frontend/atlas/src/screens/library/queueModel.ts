/**
 * The reading queue, a page at a time.
 *
 * The engine answers at most `reading_queue.MAX_PAGE_SIZE` entries a request
 * (200; a larger `limit` is refused with a 400), so a queue longer than that
 * is read in pages of that size, by `offset`.
 */
import { number } from '../today/format';

/** The engine's most entries per request, and so the size of each page here. */
export const QUEUE_PAGE = 200;

/** "Papers 201–230 of 230": the rows on screen, never a total alone. Null when there are none. */
export function pageRange(offset: number, shown: number, total: number): string | null {
  if (!shown) return null;
  return `Papers ${number(offset + 1)}–${number(offset + shown)} of ${number(total)}`;
}

/** Where the last page begins, for a queue of `total`. */
export function lastPageOffset(total: number, size = QUEUE_PAGE): number {
  return total > 0 ? Math.floor((total - 1) / size) * size : 0;
}

/**
 * The page to read instead of the one that arrived, or null to keep it.
 *
 * A page can stop existing under the reader: take out the only paper on the
 * last page, or mark it read under To read, and the engine answers that
 * offset truthfully with no entries. The queue then moves to the last page
 * there is rather than drawing an empty page over a queue that is not empty.
 */
export function pageToRead(page: { offset: number; total: number; entries: readonly unknown[] }, size = QUEUE_PAGE): number | null {
  if (page.entries.length || page.offset === 0) return null;
  const last = lastPageOffset(page.total, size);
  return last !== page.offset ? last : null;
}

/**
 * The papers an export takes: those ticked that are on this page now. A
 * paper ticked and then marked read leaves the To read page, and with it the
 * selection, so the count beside the export and what is exported cannot
 * disagree with what is on screen.
 */
export function selectedOnPage(selected: readonly number[], entries: readonly { document_id: number }[]): number[] {
  const shown = new Set(entries.map((entry) => entry.document_id));
  return selected.filter((id) => shown.has(id));
}
