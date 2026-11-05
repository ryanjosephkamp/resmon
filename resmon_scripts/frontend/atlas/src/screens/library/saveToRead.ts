/**
 * Saving many papers to the reading queue at once, apart from drawing it: the
 * requests, the question a large save asks first, and what the notice after
 * it says.
 *
 * A selection of rows read is saved by their ids (`POST /api/reading-queue/batch`).
 * Every row of a list the engine can describe (a search's every match, a
 * run's papers or its new ones, Today's new papers) is saved by describing it
 * (`/batch/all`), with the number the person was told, so the engine refuses
 * a set that has grown past it rather than saving more than was asked. A
 * paper already in the queue stays exactly as it was, read or not, and is
 * counted as such. Undo takes back the papers the save added
 * (`/batch/undo`), unless one was marked read since.
 */
import { answer, engine } from '../../api/client';
import type { components } from '../../api/schema';
import { count, number } from '../today/format';
import { UNDO_SECONDS } from './galleryModel';

export type Saved = components['schemas']['ReadingQueueBatchSaved'];
export type Undone = components['schemas']['ReadingQueueBatchUndone'];
type Filters = components['schemas']['ExplorerFilters'];

/** The most one save takes, listed or described: `reading_queue.BATCH_MOST`. */
export const SAVE_MOST = 20_000;
/** Past this many, a save asks first: more than a page of the Library's covers at once. */
export const ASK_ABOVE = 200;

/** What a save names: the rows picked, or every row of a set less the ones left out. */
export type SaveTarget =
  | { kind: 'listed'; ids: readonly number[] }
  | { kind: 'search'; search: Filters; except: readonly number[]; atMost: number }
  | { kind: 'run'; executionId: number; onlyNew: boolean; except: readonly number[]; atMost: number }
  | { kind: 'today'; collection: number | null; except: readonly number[]; atMost: number };

export async function saveToRead(target: SaveTarget): Promise<Saved> {
  if (target.kind === 'listed') {
    return answer(engine().POST('/api/reading-queue/batch', { body: { document_ids: [...target.ids] } }));
  }
  const common = { except_ids: [...target.except], at_most: target.atMost };
  const body = target.kind === 'search' ? { scope: 'search' as const, search: target.search, only_new: false, ...common }
    : target.kind === 'run' ? { scope: 'run' as const, execution_id: target.executionId, only_new: target.onlyNew, ...common }
      : { scope: 'today' as const, only_new: false, ...(target.collection !== null ? { collection: String(target.collection) } : {}), ...common };
  return answer(engine().POST('/api/reading-queue/batch/all', { body }));
}

/** Take back what a save added. Null when it added nothing, so there is nothing to undo. */
export async function undoSave(saved: Saved): Promise<Undone | null> {
  if (!saved.saved_at || !saved.saved_ids.length) return null;
  return answer(engine().POST('/api/reading-queue/batch/undo', {
    body: { document_ids: saved.saved_ids, saved_at: saved.saved_at },
  }));
}

const was = (n: number) => (n === 1 ? 'was' : 'were');

/** "12 papers saved to read. 3 were already in your reading queue." */
export function savedWords(saved: Pick<Saved, 'saved' | 'already' | 'missing'>): string {
  const parts = [
    saved.saved ? `${count(saved.saved, 'paper')} saved to read.` : 'No papers saved to read.',
    saved.already ? `${number(saved.already)} ${was(saved.already)} already in your reading queue.`
      : 'None was already in your reading queue.',
  ];
  if (saved.missing) {
    parts.push(`${number(saved.missing)} ${saved.missing === 1 ? 'is' : 'are'} no longer in your collection.`);
  }
  return parts.join(' ');
}

/** What an Undo says where it left some: they changed after the save. Null when it took back every one. */
export function undoneWords(undone: Pick<Undone, 'removed' | 'kept'>, added: number): string | null {
  const stayed = added - undone.removed;
  if (stayed <= 0) return null;
  return `Took ${count(undone.removed, 'paper')} back out. ${number(stayed)} ${stayed === 1 ? 'stays' : 'stay'}: `
    + `${stayed === 1 ? 'it was' : 'they were'} marked read or saved again after this save.`;
}

/** "Save 3 to read", "Save all 1,204 to read". */
export function saveLabel(n: number, all: boolean): string {
  return all ? `Save all ${number(n)} to read` : `Save ${number(n)} to read`;
}

/**
 * Why a save cannot be offered as it stands, or null when it can: nothing
 * picked, more than one save takes, or a whole that is not counted.
 */
export function saveRefusal(n: number | null): string | null {
  if (n === null) return 'The matches were not all counted, so they cannot be saved at once. Narrow the search.';
  if (n === 0) return null;
  if (n > SAVE_MOST) return `A save takes at most ${number(SAVE_MOST)} papers at once. Narrow it, or pick fewer.`;
  return null;
}

/** The question before a save of more than `ASK_ABOVE`: what it does and does not change. */
export function saveQuestion(what: string): string {
  return `Save ${what} to read? Each one goes to To read in the Library, and one already in your reading queue stays `
    + `as it is, read or not. For ${UNDO_SECONDS} seconds after, Undo takes back the ones this adds.`;
}
